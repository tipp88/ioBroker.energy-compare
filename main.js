'use strict';
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cron = require('node-cron');

class EnergyCompare extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'energy-compare' });
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.cronJob = null;
	}

	async onReady() {
		this.log.info('Starting Energy Compare Adapter');

		// Create Object Tree
		await this.setupObjects();

		// Validate config
		if (!this.config.octopusEmail || !this.config.octopusPassword) {
			this.log.warn('Octopus credentials missing. Please configure them in the adapter settings.');
			return; // Wait for config
		}

		if (!this.config.inexogyEmail || !this.config.inexogyPassword) {
			this.log.warn('Inexogy credentials missing. Please configure them in the adapter settings.');
			return; // Wait for config
		}

		const schedule = this.config.cronSchedule || '0 2 * * *';
		this.log.info(`Scheduling daily sync with CRON: ${schedule}`);

		// Schedule the job
		this.cronJob = cron.schedule(schedule, () => {
			this.syncData();
		});

		// Trigger an initial sync 5 seconds after startup for immediate feedback
		setTimeout(() => this.syncData(), 5000);
	}

	async setupObjects() {
		const states = [
			{
				id: 'octopus.dailyConsumption',
				name: 'Octopus Daily Consumption',
				type: 'number',
				role: 'value.power.consumption',
				unit: 'kWh',
			},
			{
				id: 'inexogy.dailyConsumption',
				name: 'Inexogy Daily Consumption',
				type: 'number',
				role: 'value.power.consumption',
				unit: 'kWh',
			},
			{ id: 'comparison.difference', name: 'Absolute Difference', type: 'number', role: 'value', unit: 'kWh' },
			{ id: 'comparison.hasDiscrepancy', name: 'Has Discrepancy', type: 'boolean', role: 'indicator', unit: '' },
			{ id: 'comparison.lastSync', name: 'Last Sync Timestamp', type: 'number', role: 'date', unit: '' },
		];

		for (const s of states) {
			// @ts-expect-error TS does not correctly infer string as CommonType in this loop
			await this.setObjectNotExistsAsync(s.id, {
				type: 'state',
				common: {
					name: s.name,
					type: s.type,
					role: s.role,
					unit: s.unit || undefined,
					read: true,
					write: false,
				},
				native: {},
			});
		}
	}

	async syncData() {
		this.log.info('Starting data sync for Octopus and Inexogy...');

		try {
			// Get Dates (e.g. yesterday)
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			yesterday.setHours(0, 0, 0, 0);

			const today = new Date();
			today.setHours(0, 0, 0, 0);

			// Fetch data
			const octopusVal = await this.fetchOctopus(yesterday, today);
			const inexogyVal = await this.fetchInexogy(yesterday, today);

			if (octopusVal !== null) {
				await this.setStateAsync('octopus.dailyConsumption', { val: octopusVal, ack: true });
			}
			if (inexogyVal !== null) {
				await this.setStateAsync('inexogy.dailyConsumption', { val: inexogyVal, ack: true });
			}

			// Compare Data
			if (octopusVal !== null && inexogyVal !== null) {
				const diff = Math.abs(octopusVal - inexogyVal);
				const threshold = Number(this.config.discrepancyThreshold) || 0.1;
				const hasDiscrepancy = diff >= threshold;

				await this.setStateAsync('comparison.difference', { val: parseFloat(diff.toFixed(3)), ack: true });
				await this.setStateAsync('comparison.hasDiscrepancy', { val: hasDiscrepancy, ack: true });
				await this.setStateAsync('comparison.lastSync', { val: Date.now(), ack: true });

				if (hasDiscrepancy) {
					this.log.warn(
						`Discrepancy detected! Octopus: ${octopusVal} kWh, Inexogy: ${inexogyVal} kWh. Diff: ${diff.toFixed(3)} kWh`,
					);
				} else {
					this.log.info(`Sync successful. No discrepancy. Diff: ${diff.toFixed(3)} kWh`);
				}
			}
		} catch (error) {
			this.log.error(`Error during syncData: ${error.message}`);
		}
	}

	async fetchOctopus(start, _end) {
		try {
			this.log.debug(`Authenticating with Kraken (Octopus) for ${this.config.octopusEmail}`);
			// 1. Authenticate with Kraken GraphQL
			// Octopus Energy Germany endpoint
			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';

			const authPayload = {
				query: `mutation obtainKrakenToken($input: ObtainJSONWebTokenInput!) {
                    obtainKrakenToken(input: $input) {
                        token
                    }
                }`,
				variables: {
					input: {
						email: this.config.octopusEmail,
						password: this.config.octopusPassword,
					},
				},
			};

			const authRes = await axios.post(apiDomain, authPayload, {
				headers: { 'Content-Type': 'application/json' },
			});

			const token = authRes.data?.data?.obtainKrakenToken?.token;
			if (!token) {
				this.log.error('Octopus Login failed. No token received.');
				this.log.debug(JSON.stringify(authRes.data));
				return null;
			}

			// 2. Query Property ID
			this.log.debug('Kraken token received. Fetching property ID...');
			const propertyPayload = {
				query: `query getPropertyIds($accountNumber: String!) {
					account(accountNumber: $accountNumber) {
						id
					}
				}`,
				variables: {
					accountNumber: this.config.octopusAccount,
				},
			};

			const propRes = await axios.post(apiDomain, propertyPayload, {
				headers: {
					'Content-Type': 'application/json',
					Authorization: token,
				},
				validateStatus: () => true,
			});

			if (propRes.status !== 200 || propRes.data?.errors) {
				this.log.error(`Octopus property fetch failed: ${JSON.stringify(propRes.data)}`);
				return null;
			}

			const propertyId = propRes.data?.data?.account?.id;
			if (!propertyId) {
				this.log.error('Could not find property ID in Kraken response.');
				return null;
			}

			// 3. Query Consumption
			this.log.debug(`Fetcing consumption for property: ${propertyId}`);
			// Format date as YYYY-MM-DD
			const dateString = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

			const usagePayload = {
				query: `query getSmartMeterUsage($accountNumber: String!, $propertyId: ID!, $date: Date!) {
					account(accountNumber: $accountNumber) {
						property(id: $propertyId) {
							measurements(
								utilityFilters: {electricityFilters: {readingFrequencyType: DAY_INTERVAL, readingQuality: ACTUAL}}
								startOn: $date
								first: 1
							) {
								edges {
									node {
										... on IntervalMeasurementType {
											endAt
											startAt
											unit
											value
										}
									}
								}
							}
						}
					}
				}`,
				variables: {
					accountNumber: this.config.octopusAccount,
					propertyId: propertyId,
					date: dateString,
				},
			};

			const dataRes = await axios.post(apiDomain, usagePayload, {
				headers: {
					'Content-Type': 'application/json',
					Authorization: token,
				},
				validateStatus: () => true,
			});

			if (dataRes.status !== 200 || dataRes.data?.errors) {
				this.log.error(`Octopus consumption fetch failed: ${JSON.stringify(dataRes.data)}`);
				return null;
			}

			// 4. Extract Data
			let total = 0;
			const edges = dataRes.data?.data?.account?.property?.measurements?.edges;

			if (edges && Array.isArray(edges) && edges.length > 0) {
				for (const edge of edges) {
					total += parseFloat(edge.node?.value || 0);
				}
				this.log.debug(`Octopus daily consumption calculated: ${total} kWh`);
				return total;
			}

			this.log.warn('Could not parse electricity readings from Kraken response.');
			this.log.debug(JSON.stringify(dataRes.data));
			return null;
		} catch (error) {
			this.log.error(`Octopus fetch error: ${error.message}`);
			return null;
		}
	}

	async fetchInexogy(start, end) {
		try {
			this.log.debug(`Authenticating with Inexogy for ${this.config.inexogyEmail}`);
			// Note: Inexogy (Discovergy) uses its OAuth or fallback Basic Auth
			const basicAuth = Buffer.from(`${this.config.inexogyEmail}:${this.config.inexogyPassword}`).toString(
				'base64',
			);

			// 1. Fetch meters to get the meterId
			const meterUrl = 'https://api.inexogy.com/public/v1/meters';
			this.log.debug(`Fetching meters: ${meterUrl}`);
			const meterRes = await axios.get(meterUrl, {
				headers: { Authorization: `Basic ${basicAuth}` },
				validateStatus: () => true,
			});

			if (meterRes.status !== 200 || !meterRes.data || meterRes.data.length === 0) {
				if (meterRes.status === 401 || meterRes.status === 403) {
					this.log.error('Inexogy Authentication failed. Verify Email and Password.');
				} else {
					this.log.error(`Inexogy meters fetch failed. Status: ${meterRes.status}`);
				}
				return null;
			}

			const meterId = meterRes.data[0].meterId;
			this.log.debug(`Found Inexogy meterId: ${meterId}`);

			// 2. Fetch statistics using the meterId
			const url = `https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${start.getTime()}&to=${end.getTime()}`;
			this.log.debug(`Fetching: ${url}`);

			const dataRes = await axios.get(url, {
				headers: { Authorization: `Basic ${basicAuth}` },
				validateStatus: () => true,
			});

			if (dataRes.status === 200 && dataRes.data && dataRes.data.energy) {
				const energyData = dataRes.data.energy;
				const min = energyData.minimum || 0;
				const max = energyData.maximum || 0;
				const diffWh = Math.abs(max - min);

				let kwh = diffWh / 10000000000; // discovergy sends often in 10^-7 kWh multipliers
				// Fallback sanity check if it's straight Wh
				if (diffWh > 0 && diffWh < 100000) {
					kwh = diffWh / 1000;
				}

				this.log.debug(`Inexogy daily consumption calculated from statistics: ${kwh} kWh`);
				return kwh;
			} else if (dataRes.status === 200) {
				this.log.warn('Inexogy statistics did not contain energy data.');
				return null;
			}
			// If BasicAuth fails, log error and try OAuth hint if necessary
			if (dataRes.status === 401 || dataRes.status === 403) {
				this.log.error('Inexogy Authentication failed. Verify Email and Password.');
			} else {
				this.log.warn(`No Inexogy data returned for period. Status: ${dataRes.status}`);
			}
			return null;
		} catch (error) {
			this.log.error(`Inexogy fetch error: ${error.message}`);
			return null;
		}
	}

	onUnload(callback) {
		try {
			if (this.cronJob) {
				this.cronJob.stop();
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new EnergyCompare(options);
} else {
	new EnergyCompare();
}
