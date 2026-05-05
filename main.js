'use strict';
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cron = require('node-cron');

class EnergyCompare extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'octopus-energy-monitor' });
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.cronJob = null;
	}

	async onReady() {
		this.log.info('Starting Octopus Energy Monitor Adapter');

		// Create Object Tree
		await this.setupObjects();

		this.hasOctopus = !!(this.config.octopusEmail && this.config.octopusPassword);
		this.hasInexogy = !!(this.config.inexogyEmail && this.config.inexogyPassword);

		// Validate config
		if (!this.hasOctopus) {
			this.log.warn('Octopus credentials missing. Adapter requires at least Octopus credentials.');
			return; // Wait for config
		}

		if (!this.hasInexogy) {
			this.log.info('Inexogy credentials missing. Adapter will run in standalone mode (Octopus only).');
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

		// Create provider summary states
		await this.setObjectNotExistsAsync('octopus.historyJson', {
			type: 'state',
			common: {
				name: 'Octopus Consumption History (JSON Array)',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});

		if (this.config.inexogyEmail) {
			await this.setObjectNotExistsAsync('inexogy.historyJson', {
				type: 'state',
				common: {
					name: 'Inexogy Consumption History (JSON Array)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			});
		}
	}

	/**
	 * @param {string} id
	 * @param {string} name
	 * @param {any} value
	 * @param {string} [role]
	 * @param {ioBroker.CommonType} [type]
	 */
	async writeStateObject(id, name, value, role = 'value.power.consumption', type = 'number') {
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: {
				name: name,
				type: type,
				role: role,
				unit: role.includes('power') || name.includes('Difference') ? 'kWh' : '',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setStateAsync(id, { val: value, ack: true });
	}

	async syncData() {
		const syncDays = Number(this.config.syncDays) || 30;
		this.log.info(`Starting ${syncDays}-day retroactive data sync...`);

		// Start with cleanup
		await this.cleanupHistory();

		try {
			for (let i = syncDays; i >= 1; i--) {
				const targetDate = new Date();
				targetDate.setDate(targetDate.getDate() - i);
				targetDate.setHours(0, 0, 0, 0);

				const endDate = new Date();
				endDate.setDate(endDate.getDate() - i + 1);
				endDate.setHours(0, 0, 0, 0);

				const dateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
				const basePath = `history.${dateStr}`;

				// Cache Check: Determine if the sync for this day has already been completed successfully
				let isCached = false;
				if (this.hasInexogy) {
					if (this.config.splitGoTariff) {
						const diffState = await this.getStateAsync(`${basePath}.comparison.standardDifference`);
						isCached = !!(diffState && diffState.val !== null && diffState.val !== undefined);
					} else {
						const diffState = await this.getStateAsync(`${basePath}.comparison.difference`);
						isCached = !!(diffState && diffState.val !== null && diffState.val !== undefined);
					}
				} else {
					if (this.config.splitGoTariff) {
						const octState = await this.getStateAsync(`${basePath}.octopus.standardConsumption`);
						isCached = !!(octState && octState.val !== null && octState.val !== undefined);
					} else {
						const octState = await this.getStateAsync(`${basePath}.octopus.dailyConsumption`);
						isCached = !!(octState && octState.val !== null && octState.val !== undefined);
					}
				}

				if (isCached) {
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
				const octopusData = await this.fetchOctopus(targetDate, endDate, this.config.splitGoTariff);
				let inexogyData = null;
				if (this.hasInexogy) {
					inexogyData = await this.fetchInexogy(targetDate, endDate, this.config.splitGoTariff);
				}

				// Check data fetching success
				if (octopusData === null || (this.hasInexogy && inexogyData === null)) {
					this.log.warn(`Skipping ${dateStr} due to missing provider data.`);
					continue;
				}

				const threshold = Number(this.config.discrepancyThreshold) || 0.1;

				if (this.config.splitGoTariff) {
					// Split Write
					await this.writeStateObject(
						`${basePath}.octopus.goConsumption`,
						'Octopus Go Consumption',
						octopusData.go,
					);
					await this.writeStateObject(
						`${basePath}.octopus.standardConsumption`,
						'Octopus Standard Consumption',
						octopusData.standard,
					);

					if (inexogyData) {
						await this.writeStateObject(
							`${basePath}.inexogy.goConsumption`,
							'Inexogy Go Consumption',
							inexogyData.go,
						);
						await this.writeStateObject(
							`${basePath}.inexogy.standardConsumption`,
							'Inexogy Standard Consumption',
							inexogyData.standard,
						);

						const goDiff = Math.abs(octopusData.go - inexogyData.go);
						const stdDiff = Math.abs(octopusData.standard - inexogyData.standard);

						await this.writeStateObject(
							`${basePath}.comparison.goDifference`,
							'Go Absolute Difference',
							parseFloat(goDiff.toFixed(3)),
							'value',
						);
						await this.writeStateObject(
							`${basePath}.comparison.standardDifference`,
							'Standard Absolute Difference',
							parseFloat(stdDiff.toFixed(3)),
							'value',
						);

						if (goDiff >= threshold || stdDiff >= threshold) {
							this.log.warn(
								`Discrepancy detected for ${dateStr}! Go Diff: ${goDiff.toFixed(3)} kWh, Std Diff: ${stdDiff.toFixed(3)} kWh`,
							);
						} else {
							this.log.info(
								`Sync for ${dateStr} successful. Go Diff: ${goDiff.toFixed(3)}, Std Diff: ${stdDiff.toFixed(3)}`,
							);
						}
					} else {
						this.log.info(
							`Sync for ${dateStr} successful (Octopus Only, Split). Go: ${octopusData.go}, Std: ${octopusData.standard}`,
						);
					}
				} else {
					// Normal Write
					await this.writeStateObject(
						`${basePath}.octopus.dailyConsumption`,
						'Octopus Daily Consumption',
						octopusData.total,
					);

					if (inexogyData) {
						await this.writeStateObject(
							`${basePath}.inexogy.dailyConsumption`,
							'Inexogy Daily Consumption',
							inexogyData.total,
						);

						const diff = Math.abs(octopusData.total - inexogyData.total);
						const hasDiscrepancy = diff >= threshold;

						await this.writeStateObject(
							`${basePath}.comparison.difference`,
							'Absolute Difference',
							parseFloat(diff.toFixed(3)),
							'value',
						);
						await this.writeStateObject(
							`${basePath}.comparison.hasDiscrepancy`,
							'Has Discrepancy',
							hasDiscrepancy,
							'indicator',
							'boolean',
						);

						if (hasDiscrepancy) {
							this.log.warn(
								`Discrepancy detected for ${dateStr}! Octopus: ${octopusData.total} kWh, Inexogy: ${inexogyData.total} kWh. Diff: ${diff.toFixed(3)} kWh`,
							);
						} else {
							this.log.info(
								`Sync for ${dateStr} successful. No discrepancy. Diff: ${diff.toFixed(3)} kWh`,
							);
						}
					} else {
						this.log.info(`Sync for ${dateStr} successful (Octopus Only): ${octopusData.total} kWh`);
					}
				}
			}

			this.log.info(`${syncDays}-day sync cycle completed successfully.`);

			// After sync loop, update the aggregate JSON states
			await this.updateHistoryJson();
		} catch (error) {
			this.log.error(`Error during syncData: ${error.message}`);
		}
	}

	async fetchOctopus(start, _end, split) {
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
								utilityFilters: {electricityFilters: {readingFrequencyType: ${split ? 'RAW_INTERVAL' : 'DAY_INTERVAL'}, readingQuality: ACTUAL}}
								startOn: $date
								first: ${split ? 150 : 1}
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
			let go = 0;
			let standard = 0;
			const edges = dataRes.data?.data?.account?.property?.measurements?.edges;

			if (edges && Array.isArray(edges) && edges.length > 0) {
				this.log.debug(
					`Octopus: Processing ${edges.length} edges for ${dateString}. First unit: ${edges[0].node.unit}`,
				);
				const startMs = start.getTime();
				const endMs = start.getTime() + 24 * 60 * 60 * 1000;

				for (const edge of edges) {
					const nodeVal = parseFloat(edge.node?.value || 0);
					const startDt = new Date(edge.node.startAt);
					const nodeMs = startDt.getTime();

					// Strict Date Check: only sum values that belong to the target 24h window
					if (nodeMs < startMs || nodeMs >= endMs) {
						continue;
					}

					total += nodeVal;

					if (split) {
						if (startDt.getHours() < 5) {
							go += nodeVal;
						} else {
							standard += nodeVal;
						}
					}
				}
				this.log.debug(`Octopus calculated: total=${total}, go=${go}, std=${standard}`);
				return {
					total: parseFloat(total.toFixed(3)),
					go: parseFloat(go.toFixed(3)),
					standard: parseFloat(standard.toFixed(3)),
				};
			}

			this.log.warn('Could not parse electricity readings from Kraken response.');
			this.log.debug(JSON.stringify(dataRes.data));
			return null;
		} catch (error) {
			this.log.error(`Octopus fetch error: ${error.message}`);
			return null;
		}
	}

	parseInexogyData(dataRes) {
		if (dataRes.status === 200 && dataRes.data && dataRes.data.energy) {
			const energyData = dataRes.data.energy;
			const min = energyData.minimum || 0;
			const max = energyData.maximum || 0;
			const diffWh = Math.abs(max - min);

			let kwh = diffWh / 10000000000;
			if (diffWh > 0 && diffWh < 100000) {
				kwh = diffWh / 1000;
			}

			return parseFloat(kwh.toFixed(3));
		}
		return null;
	}

	async fetchInexogy(start, end, split) {
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
			const headers = { Authorization: `Basic ${basicAuth}` };

			if (!split) {
				const url = `https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${start.getTime()}&to=${end.getTime()}`;
				this.log.debug(`Fetching: ${url}`);

				const dataRes = await axios.get(url, { headers, validateStatus: () => true });
				const total = this.parseInexogyData(dataRes);
				if (total !== null) {
					return { total, go: 0, standard: 0 };
				} else if (dataRes.status === 401 || dataRes.status === 403) {
					this.log.error('Inexogy Authentication failed. Verify Email and Password.');
				} else {
					this.log.warn(`No Inexogy data returned. Status: ${dataRes.status}`);
				}
				return null;
			}
			const goEnd = new Date(start.getTime());
			goEnd.setHours(5, 0, 0, 0);

			const urlGo = `https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${start.getTime()}&to=${goEnd.getTime()}`;
			const resGo = await axios.get(urlGo, { headers, validateStatus: () => true });
			const go = this.parseInexogyData(resGo);

			const urlStd = `https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${goEnd.getTime()}&to=${end.getTime()}`;
			const resStd = await axios.get(urlStd, { headers, validateStatus: () => true });
			const standard = this.parseInexogyData(resStd);

			if (go !== null && standard !== null) {
				const total = parseFloat((go + standard).toFixed(3));
				return { total, go, standard };
			} else if (resGo.status === 401 || resGo.status === 403 || resStd.status === 401 || resStd.status === 403) {
				this.log.error('Inexogy Authentication failed. Verify Email and Password.');
			} else {
				this.log.warn(`Inexogy data split fetch failed.`);
			}
			return null;
		} catch (error) {
			this.log.error(`Inexogy fetch error: ${error.message}`);
			return null;
		}
	}

	async cleanupHistory() {
		const retentionDays = Number(this.config.retentionDays);
		if (isNaN(retentionDays) || retentionDays <= 0) {
			this.log.debug('Retention disabled or invalid value.');
			return;
		}

		this.log.info(`Cleaning up history older than ${retentionDays} days...`);
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
		cutoffDate.setHours(0, 0, 0, 0);

		// Get all objects under history
		const objects = await this.getAdapterObjectsAsync();
		const historyPrefix = `${this.namespace}.history.`;

		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				// ID format: octopus-energy-monitor.0.history.YYYY-MM-DD...
				const relativeId = id.substring(historyPrefix.length);
				const datePart = relativeId.split('.')[0]; // YYYY-MM-DD

				if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
					const [year, month, day] = datePart.split('-').map(Number);
					const stateDate = new Date(year, month - 1, day);
					if (stateDate < cutoffDate) {
						this.log.debug(`Deleting old history object: ${id}`);
						// delObject needs id without namespace
						await this.delObjectAsync(id.substring(this.namespace.length + 1));
					}
				}
			}
		}
	}

	async updateHistoryJson() {
		this.log.info('Updating history JSON arrays...');
		const objects = await this.getAdapterObjectsAsync();
		const historyPrefix = `${this.namespace}.history.`;

		const dates = new Set();
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const datePart = relativeId.split('.')[0];
				if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
					dates.add(datePart);
				}
			}
		}

		const sortedDates = Array.from(dates).sort();
		const octopusHistory = [];
		const inexogyHistory = [];

		for (const dateStr of sortedDates) {
			const [year, month, day] = dateStr.split('-').map(Number);
			const timestamp = new Date(year, month - 1, day).getTime();
			const basePath = `history.${dateStr}`;

			// Octopus
			const octGo = await this.getStateAsync(`${basePath}.octopus.goConsumption`);
			const octStd = await this.getStateAsync(`${basePath}.octopus.standardConsumption`);
			const octTotal = await this.getStateAsync(`${basePath}.octopus.dailyConsumption`);

			const octGoVal = octGo && octGo.val != null ? Number(octGo.val) : 0;
			const octStdVal = octStd && octStd.val != null ? Number(octStd.val) : 0;
			const octTotalVal =
				octTotal && octTotal.val != null ? Number(octTotal.val) : parseFloat((octGoVal + octStdVal).toFixed(3));

			octopusHistory.push({
				date: dateStr,
				timestamp: timestamp,
				go: octGoVal,
				standard: octStdVal,
				total: octTotalVal,
			});

			// Inexogy
			if (this.hasInexogy) {
				const inxGo = await this.getStateAsync(`${basePath}.inexogy.goConsumption`);
				const inxStd = await this.getStateAsync(`${basePath}.inexogy.standardConsumption`);
				const inxTotal = await this.getStateAsync(`${basePath}.inexogy.dailyConsumption`);

				const inxGoVal = inxGo && inxGo.val != null ? Number(inxGo.val) : 0;
				const inxStdVal = inxStd && inxStd.val != null ? Number(inxStd.val) : 0;
				const inxTotalVal =
					inxTotal && inxTotal.val != null
						? Number(inxTotal.val)
						: parseFloat((inxGoVal + inxStdVal).toFixed(3));

				inexogyHistory.push({
					date: dateStr,
					timestamp: timestamp,
					go: inxGoVal,
					standard: inxStdVal,
					total: inxTotalVal,
				});
			}
		}

		await this.setStateAsync('octopus.historyJson', { val: JSON.stringify(octopusHistory), ack: true });
		if (this.hasInexogy) {
			await this.setStateAsync('inexogy.historyJson', { val: JSON.stringify(inexogyHistory), ack: true });
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
