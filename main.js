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
		/** @type {Array<{id: string, name: string, type: ioBroker.CommonType, role: string, unit?: string}>} */
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

	async fetchOctopus(start, end) {
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

			// 2. Query Consumption via GraphQL
			this.log.debug('Kraken token received. Fetching consumption...');
			const consumptionPayload = {
				query: `query getConsumption($accountNumber: String!, $startAt: DateTime!, $endAt: DateTime!) {
                    account(accountNumber: $accountNumber) {
                        properties {
                            electricityMeterPoints {
                                halfHourlyReadings(startAt: $startAt, endAt: $endAt) {
                                    value
                                }
                            }
                        }
                    }
                }`,
				variables: {
					accountNumber: this.config.octopusAccount,
					startAt: start.toISOString(),
					endAt: end.toISOString(),
				},
			};

			const dataRes = await axios.post(apiDomain, consumptionPayload, {
				headers: {
					'Content-Type': 'application/json',
					Authorization: token,
				},
			});

			// 3. Extract and Sum Data
			let total = 0;
			const properties = dataRes.data?.data?.account?.properties;
			if (properties && properties.length > 0) {
				const points = properties[0]?.electricityMeterPoints?.[0]?.halfHourlyReadings;
				if (points && Array.isArray(points)) {
					for (const reading of points) {
						total += parseFloat(reading.value || 0);
					}
					this.log.debug(`Octopus daily consumption calculated: ${total} kWh`);
					return total;
				}
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

			// 2. Fetch readings using the meterId
			const url = `https://api.inexogy.com/public/v1/readings?meterId=${meterId}&from=${start.getTime()}&to=${end.getTime()}&resolution=one_day`;
			this.log.debug(`Fetching: ${url}`);

			const dataRes = await axios.get(url, {
				headers: { Authorization: `Basic ${basicAuth}` },
				validateStatus: () => true,
			});

			if (dataRes.status === 200 && dataRes.data && dataRes.data.length > 0) {
				// Typical Discovergy API returns energy/energyOut (either in WH or 10^-7 kWh)
				// Assuming standard energy in Wh (Watt-hours)
				let energyWh = dataRes.data[0].values?.energy || 0;
				let kwh = energyWh / 10000000000; // discovergy sends often in 10^-7 kWh multipliers

				// Fallback sanity check if it's straight Wh
				if (energyWh > 0 && energyWh < 100000) {
					kwh = energyWh / 1000;
				}

				this.log.debug(`Inexogy daily consumption calculated: ${kwh} kWh`);
				return kwh;
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
