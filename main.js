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
		// Create the root history device/folder
		await this.setObjectNotExistsAsync('history', {
			type: 'device',
			common: {
				name: 'Daily History',
			},
			native: {},
		});
	}

	async syncData() {
		this.log.info('Starting 30-day retroactive data sync for Octopus and Inexogy...');

		try {
			for (let i = 30; i >= 1; i--) {
				const targetDate = new Date();
				targetDate.setDate(targetDate.getDate() - i);
				targetDate.setHours(0, 0, 0, 0);

				const endDate = new Date();
				endDate.setDate(endDate.getDate() - i + 1);
				endDate.setHours(0, 0, 0, 0);

				const dateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
				const basePath = `history.${dateStr}`;

				// Cache Check: Determine if the sync for this day has already been completed successfully
				const diffState = await this.getStateAsync(`${basePath}.comparison.difference`);
				if (diffState && diffState.val !== null && diffState.val !== undefined) {
					this.log.debug(`Skipping ${dateStr}, data already synced and cached.`);
					continue;
				}

				this.log.debug(`Syncing data for ${dateStr}...`);

				// Build the day's object structure dynamically
				await this.setObjectNotExistsAsync(basePath, {
					type: 'channel',
					common: { name: `Data for ${dateStr}` },
					native: {},
				});

				// Fetch data for the specific day
				const octopusVal = await this.fetchOctopus(targetDate, endDate);
				const inexogyVal = await this.fetchInexogy(targetDate, endDate);

				// If we failed to get data for both providers, skip state writing and retry next cron
				if (octopusVal === null || inexogyVal === null) {
					this.log.warn(`Skipping ${dateStr} comparison due to missing provider data.`);
					continue;
				}

				// Write Octopus Data
				await this.setObjectNotExistsAsync(`${basePath}.octopus.dailyConsumption`, {
					type: 'state',
					common: {
						name: 'Octopus Daily Consumption',
						type: 'number',
						role: 'value.power.consumption',
						unit: 'kWh',
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync(`${basePath}.octopus.dailyConsumption`, { val: octopusVal, ack: true });

				// Write Inexogy Data
				await this.setObjectNotExistsAsync(`${basePath}.inexogy.dailyConsumption`, {
					type: 'state',
					common: {
						name: 'Inexogy Daily Consumption',
						type: 'number',
						role: 'value.power.consumption',
						unit: 'kWh',
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync(`${basePath}.inexogy.dailyConsumption`, { val: inexogyVal, ack: true });

				// Compare Data
				const diff = Math.abs(octopusVal - inexogyVal);
				const threshold = Number(this.config.discrepancyThreshold) || 0.1;
				const hasDiscrepancy = diff >= threshold;

				await this.setObjectNotExistsAsync(`${basePath}.comparison.difference`, {
					type: 'state',
					common: {
						name: 'Absolute Difference',
						type: 'number',
						role: 'value',
						unit: 'kWh',
						read: true,
						write: false,
					},
					native: {},
				});
				await this.setStateAsync(`${basePath}.comparison.difference`, {
					val: parseFloat(diff.toFixed(3)),
					ack: true,
				});

				await this.setObjectNotExistsAsync(`${basePath}.comparison.hasDiscrepancy`, {
					type: 'state',
					common: { name: 'Has Discrepancy', type: 'boolean', role: 'indicator', read: true, write: false },
					native: {},
				});
				await this.setStateAsync(`${basePath}.comparison.hasDiscrepancy`, { val: hasDiscrepancy, ack: true });

				// Log Result
				if (hasDiscrepancy) {
					this.log.warn(
						`Discrepancy detected for ${dateStr}! Octopus: ${octopusVal} kWh, Inexogy: ${inexogyVal} kWh. Diff: ${diff.toFixed(3)} kWh`,
					);
				} else {
					this.log.info(`Sync for ${dateStr} successful. No discrepancy. Diff: ${diff.toFixed(3)} kWh`);
				}
			}

			this.log.info('30-day sync cycle completed successfully.');
		} catch (error) {
			this.log.error(`Error during syncData: ${error.message}`);
		}
	}

	async fetchOctopus(start, _end) {
		try {
			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';

			// 1. Authenticate with Kraken GraphQL (Cached)
			if (!this.octopusAuthToken) {
				this.log.debug(`Authenticating with Kraken (Octopus) for ${this.config.octopusEmail}`);
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
				this.octopusAuthToken = token;
			}

			// 2. Query Property ID (if not provided in config or cached)
			let propertyId = this.config.octopusPropertyId || '';

			if (!propertyId) {
				if (!this.octopusDynamicPropertyId) {
					this.log.debug('Kraken token received. Fetching property ID dynamically...');
					const propertyPayload = {
						query: `query getPropertyIds($accountNumber: String!) {
							account(accountNumber: $accountNumber) {
								properties {
									id
								}
							}
						}`,
						variables: {
							accountNumber: this.config.octopusAccount,
						},
					};

					const propRes = await axios.post(apiDomain, propertyPayload, {
						headers: {
							'Content-Type': 'application/json',
							Authorization: this.octopusAuthToken,
						},
						validateStatus: () => true,
					});

					if (propRes.status !== 200 || propRes.data?.errors) {
						this.log.error(`Octopus property fetch failed: ${JSON.stringify(propRes.data)}`);
						return null;
					}

					const propertiesList = propRes.data?.data?.account?.properties;
					if (!propertiesList || propertiesList.length === 0) {
						this.log.error('Could not find any properties in Kraken response.');
						return null;
					}

					this.octopusDynamicPropertyId = propertiesList[0].id;
				}
				propertyId = this.octopusDynamicPropertyId;
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
					Authorization: this.octopusAuthToken,
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

			// 1. Fetch meters to get the meterId (Cached)
			if (!this.inexogyMeterId) {
				this.log.debug(`Authenticating with Inexogy for ${this.config.inexogyEmail}`);
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

				this.inexogyMeterId = meterRes.data[0].meterId;
				this.log.debug(`Found Inexogy meterId: ${this.inexogyMeterId}`);
			}

			const meterId = this.inexogyMeterId;

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
