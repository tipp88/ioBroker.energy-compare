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
		this.masterData = null;
		this.octopusAuthToken = null;
		this.inexogyMeterId = null;
	}

	async onReady() {
		this.log.info('Starting Octopus Energy Monitor Adapter');

		this.hasOctopus = !!(this.config.octopusEmail && this.config.octopusPassword);
		this.hasInexogy = !!(this.config.inexogyEmail && this.config.inexogyPassword);

		if (!this.hasOctopus) {
			this.log.warn('Octopus credentials missing. Adapter requires at least Octopus credentials.');
			return;
		}

		if (!this.hasInexogy) {
			this.log.info('Inexogy credentials missing. Adapter will run in standalone mode (Octopus only).');
		}

		await this.cleanupLegacyHistory();
		await this.setupObjects();

		const schedule = this.config.cronSchedule || '0 2 * * *';
		this.log.info(`Scheduling daily sync with CRON: ${schedule}`);

		this.cronJob = cron.schedule(schedule, () => {
			this.syncData();
		});

		setTimeout(() => this.syncData(), 5000);
	}

	async cleanupLegacyHistory() {
		this.log.debug('Checking for legacy history.YYYY-MM-DD objects...');
		const objects = await this.getAdapterObjectsAsync();
		const historyPrefix = `${this.namespace}.history.`;
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const datePart = relativeId.split('.')[0];
				if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
					this.log.info(`Deleting legacy history object: ${id}`);
					await this.delObjectAsync(id.substring(this.namespace.length + 1));
				}
			}
		}
	}

	async setupObjects() {
		await this.setObjectNotExistsAsync('history', {
			type: 'device',
			common: { name: 'Energy History' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.info', {
			type: 'channel',
			common: { name: 'Octopus Master Data' },
			native: {},
		});
		await this.setObjectNotExistsAsync('octopus.currentMonth', {
			type: 'channel',
			common: { name: 'Current Month Aggregation' },
			native: {},
		});

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
	 * @param {string} id Object ID
	 * @param {string} name Object Name
	 * @param {any} value State Value
	 * @param {string} [role] State Role
	 * @param {ioBroker.CommonType} [type] State Type
	 * @param {string} [unit] State Unit
	 */
	async writeStateObject(id, name, value, role = 'value', type = 'number', unit = '') {
		if (!unit) {
			if (role.includes('power') || name.includes('Consumption') || name.includes('Difference')) {
				unit = 'kWh';
			} else if (name.includes('Cost') || name.includes('Balance')) {
				unit = '€';
			}
		}
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: { name, type, role, unit, read: true, write: false },
			native: {},
		});
		await this.setStateAsync(id, { val: value, ack: true });
	}

	async writeMasterDataStates(data) {
		await this.writeStateObject('octopus.info.balance', 'Account Balance', data.balance, 'value', 'number', '€');
		await this.writeStateObject('octopus.info.tariffName', 'Tariff Name', data.tariffName, 'text', 'string');
		await this.writeStateObject(
			'octopus.info.isTimeOfUse',
			'Is Time Of Use Tariff',
			data.isTimeOfUse,
			'indicator',
			'boolean',
		);
		await this.writeStateObject('octopus.info.meterNumber', 'Meter Number', data.meterNumber, 'text', 'string');
		await this.writeStateObject('octopus.info.mopName', 'Metering Point Operator', data.mopName, 'text', 'string');
		await this.writeStateObject(
			'octopus.info.dnoName',
			'Distribution Network Operator',
			data.dnoName,
			'text',
			'string',
		);

		for (const rate of data.rates) {
			await this.writeStateObject(
				`octopus.info.rates.${rate.name.toLowerCase()}`,
				`Rate ${rate.name} (€/kWh)`,
				parseFloat(rate.rateEuros.toFixed(4)),
				'value',
				'number',
				'€/kWh',
			);
		}
	}

	async fetchOctopusMasterData() {
		try {
			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';

			if (!this.octopusAuthToken) {
				const authPayload = {
					query: `mutation obtainKrakenToken($input: ObtainJSONWebTokenInput!) {
						obtainKrakenToken(input: $input) { token }
					}`,
					variables: { input: { email: this.config.octopusEmail, password: this.config.octopusPassword } },
				};
				const authRes = await axios.post(apiDomain, authPayload, {
					headers: { 'Content-Type': 'application/json' },
				});
				const token = authRes.data?.data?.obtainKrakenToken?.token;
				if (!token) {
					throw new Error('Octopus Login failed.');
				}
				this.octopusAuthToken = token;
			}

			const masterDataPayload = {
				query: `query MyQuery($accountNumber: String!) {
					account(accountNumber: $accountNumber) {
						properties {
							id
							electricityMalos {
								agreements {
									isActive
									product { displayName isTimeOfUse fullName }
									unitRateInformation {
										... on SimpleProductUnitRateInformation {
											__typename latestGrossUnitRateCentsPerKwh
										}
										... on TimeOfUseProductUnitRateInformation {
											__typename
											rates {
												latestGrossUnitRateCentsPerKwh
												timeslotName
												timeslotActivationRules { activeFromTime activeToTime }
											}
										}
									}
								}
								meters { id number }
								mop { name }
								dno { name }
							}
						}
						electricityBalance
					}
				}`,
				variables: { accountNumber: this.config.octopusAccount },
			};

			const dataRes = await axios.post(apiDomain, masterDataPayload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
			});

			if (dataRes.status !== 200 || !dataRes.data?.data?.account) {
				throw new Error('Master data fetch failed');
			}

			const account = dataRes.data.data.account;
			const properties = account.properties || [];
			if (properties.length === 0) {
				throw new Error('No properties found');
			}

			const prop = properties[0];
			const propertyId = prop.id;
			const malo = prop.electricityMalos?.[0];
			if (!malo) {
				throw new Error('No electricityMalos found');
			}

			const activeAgreement = malo.agreements?.find(a => a.isActive);
			if (!activeAgreement) {
				throw new Error('No active agreement found');
			}

			let rates = [];
			if (activeAgreement.unitRateInformation.__typename === 'TimeOfUseProductUnitRateInformation') {
				rates = activeAgreement.unitRateInformation.rates.map(r => ({
					name: r.timeslotName,
					rateEuros: parseFloat(r.latestGrossUnitRateCentsPerKwh) / 100,
					from: r.timeslotActivationRules[0]?.activeFromTime,
					to: r.timeslotActivationRules[0]?.activeToTime,
				}));
			} else {
				rates = [
					{
						name: 'STANDARD',
						rateEuros: parseFloat(activeAgreement.unitRateInformation.latestGrossUnitRateCentsPerKwh) / 100,
						from: '00:00:00',
						to: '24:00:00',
					},
				];
			}

			const masterData = {
				balance: account.electricityBalance ? parseFloat(account.electricityBalance) / 100 : 0,
				propertyId: propertyId,
				tariffName: activeAgreement.product?.displayName || 'Unknown',
				isTimeOfUse: activeAgreement.product?.isTimeOfUse || false,
				meterNumber: malo.meters?.[0]?.number || 'Unknown',
				meterId: malo.meters?.[0]?.id || '',
				mopName: malo.mop?.name || 'Unknown',
				dnoName: malo.dno?.name || 'Unknown',
				rates: rates,
			};

			this.masterData = masterData;
			await this.writeMasterDataStates(masterData);
			this.log.info('Octopus master data fetched and updated.');
			return masterData;
		} catch (error) {
			this.log.error(`Failed to fetch master data: ${error.message}`);
			return null;
		}
	}

	async fetchOctopusMeterReadings() {
		try {
			if (!this.masterData || !this.masterData.meterId) {
				return null;
			}

			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';
			const currentYear = new Date().getFullYear();
			const readFrom = `${currentYear}-01-01T00:00:00Z`;

			const readingsPayload = {
				query: `query MyQuery($accountNumber: String!, $meterId: ID!, $readFrom: DateTime!) {
					electricityMeterReadings(
						meterId: $meterId
						accountNumber: $accountNumber
						last: 100
						readFrom: $readFrom
					) {
						edges {
							node {
								value
								readAt
								typeOfRead
								status
							}
						}
					}
				}`,
				variables: {
					accountNumber: this.config.octopusAccount,
					meterId: this.masterData.meterId,
					readFrom: readFrom,
				},
			};

			const dataRes = await axios.post(apiDomain, readingsPayload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
			});

			if (dataRes.status !== 200 || !dataRes.data?.data?.electricityMeterReadings) {
				this.log.warn(
					`Octopus readings API returned status ${dataRes.status}: ${JSON.stringify(dataRes.data)}`,
				);
				return null;
			}

			const edges = dataRes.data.data.electricityMeterReadings.edges;
			if (!edges || edges.length === 0) {
				return null;
			}

			// Sort by readAt descending to find the latest
			const readings = edges
				.map(e => ({
					value: parseFloat(e.node.value),
					readAt: new Date(e.node.readAt),
				}))
				.sort((a, b) => b.readAt.getTime() - a.readAt.getTime());

			return readings[0];
		} catch (error) {
			this.log.error(`Octopus meter readings fetch error: ${error.message}`);
			return null;
		}
	}

	timeStrToHours(timeStr) {
		if (!timeStr) {
			return 0;
		}
		const parts = timeStr.split(':');
		return parseInt(parts[0], 10) + parseInt(parts[1] || 0, 10) / 60;
	}

	async fetchOctopus(start, _end) {
		try {
			if (!this.masterData) {
				return null;
			}
			const isSplit = this.masterData.isTimeOfUse && this.masterData.rates.length > 1;

			const apiDomain = 'https://api.oeg-kraken.energy/v1/graphql/';
			const dateString = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

			const usagePayload = {
				query: `query getSmartMeterUsage($accountNumber: String!, $propertyId: ID!, $date: Date!) {
					account(accountNumber: $accountNumber) {
						property(id: $propertyId) {
							measurements(
								utilityFilters: {electricityFilters: {readingFrequencyType: ${isSplit ? 'RAW_INTERVAL' : 'DAY_INTERVAL'}, readingQuality: ACTUAL}}
								startOn: $date
								first: ${isSplit ? 150 : 1}
							) {
								edges { node { ... on IntervalMeasurementType { endAt startAt value } } }
							}
						}
					}
				}`,
				variables: {
					accountNumber: this.config.octopusAccount,
					propertyId: this.masterData.propertyId,
					date: dateString,
				},
			};

			const dataRes = await axios.post(apiDomain, usagePayload, {
				headers: { 'Content-Type': 'application/json', Authorization: this.octopusAuthToken },
				validateStatus: () => true,
			});

			if (dataRes.status !== 200 || !dataRes.data?.data?.account) {
				return null;
			}

			const edges = dataRes.data.data.account.property?.measurements?.edges;
			if (!edges || edges.length === 0) {
				return null;
			}

			const startMs = start.getTime();
			const endMs = start.getTime() + 24 * 60 * 60 * 1000;

			let result = { total: 0, slots: {} };
			for (const r of this.masterData.rates) {
				result.slots[r.name] = { consumption: 0, cost: 0, rateEuros: r.rateEuros };
			}

			for (const edge of edges) {
				const nodeVal = parseFloat(edge.node?.value || 0);
				const startDt = new Date(edge.node.startAt);
				const nodeMs = startDt.getTime();

				if (nodeMs < startMs || nodeMs >= endMs) {
					continue;
				}

				result.total += nodeVal;

				if (isSplit) {
					const nodeHour = startDt.getHours() + startDt.getMinutes() / 60;
					let slotted = false;
					for (const rate of this.masterData.rates) {
						const fromH = this.timeStrToHours(rate.from);
						const toH = this.timeStrToHours(rate.to) || 24;

						let inSlot = false;
						if (fromH < toH) {
							inSlot = nodeHour >= fromH && nodeHour < toH;
						} else {
							// wraps around midnight, e.g. 23:00 to 05:00
							inSlot = nodeHour >= fromH || nodeHour < toH;
						}

						if (inSlot) {
							result.slots[rate.name].consumption += nodeVal;
							slotted = true;
							break;
						}
					}
					// fallback to first slot if not matched
					if (!slotted && this.masterData.rates.length > 0) {
						result.slots[this.masterData.rates[0].name].consumption += nodeVal;
					}
				} else {
					result.slots[this.masterData.rates[0].name].consumption += nodeVal;
				}
			}

			let totalCost = 0;
			for (const key of Object.keys(result.slots)) {
				result.slots[key].cost = result.slots[key].consumption * result.slots[key].rateEuros;
				totalCost += result.slots[key].cost;
			}
			result.totalCost = totalCost;

			return result;
		} catch (error) {
			this.log.error(`Octopus fetch error: ${error.message}`);
			return null;
		}
	}

	parseInexogyData(dataRes) {
		if (dataRes.status === 200 && dataRes.data && dataRes.data.energy) {
			const diffWh = Math.abs((dataRes.data.energy.maximum || 0) - (dataRes.data.energy.minimum || 0));
			let kwh = diffWh / 10000000000;
			if (diffWh > 0 && diffWh < 100000) {
				kwh = diffWh / 1000;
			}
			return parseFloat(kwh.toFixed(3));
		}
		return null;
	}

	async fetchInexogy(start, end) {
		try {
			if (!this.masterData) {
				return null;
			}
			const isSplit = this.masterData.isTimeOfUse && this.masterData.rates.length > 1;
			const basicAuth = Buffer.from(`${this.config.inexogyEmail}:${this.config.inexogyPassword}`).toString(
				'base64',
			);

			if (!this.inexogyMeterId) {
				const meterRes = await axios.get('https://api.inexogy.com/public/v1/meters', {
					headers: { Authorization: `Basic ${basicAuth}` },
					validateStatus: () => true,
				});
				if (meterRes.status !== 200 || !meterRes.data || meterRes.data.length === 0) {
					return null;
				}
				this.inexogyMeterId = meterRes.data[0].meterId;
			}

			const meterId = this.inexogyMeterId;
			const headers = { Authorization: `Basic ${basicAuth}` };

			if (!isSplit) {
				const url = `https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${start.getTime()}&to=${end.getTime()}`;
				const dataRes = await axios.get(url, { headers, validateStatus: () => true });
				const total = this.parseInexogyData(dataRes);
				if (total !== null) {
					let slots = {};
					slots[this.masterData.rates[0].name] = { consumption: total };
					return { total, slots };
				}
				return null;
			}

			let result = { total: 0, slots: {} };
			for (const rate of this.masterData.rates) {
				const fromH = this.timeStrToHours(rate.from);
				const toH = this.timeStrToHours(rate.to) || 24;

				// Simplify Inexogy fetching: just handle standard 1 contiguous block for now
				// If a tariff wraps around midnight (e.g. 23:00 to 05:00), we need two queries for the day.
				let consumption = 0;
				if (fromH < toH) {
					const sTime = new Date(start.getTime());
					sTime.setHours(fromH, 0, 0, 0);
					const eTime = new Date(start.getTime());
					eTime.setHours(toH, 0, 0, 0);
					const url = `https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${sTime.getTime()}&to=${eTime.getTime()}`;
					const res = await axios.get(url, { headers, validateStatus: () => true });
					consumption += this.parseInexogyData(res) || 0;
				} else {
					// from 23 to 05 (next day) but we are querying for the current day.
					// This means 00:00 to 05:00 and 23:00 to 24:00
					const s1 = new Date(start.getTime());
					s1.setHours(0, 0, 0, 0);
					const e1 = new Date(start.getTime());
					e1.setHours(toH, 0, 0, 0);
					const res1 = await axios.get(
						`https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${s1.getTime()}&to=${e1.getTime()}`,
						{ headers, validateStatus: () => true },
					);
					consumption += this.parseInexogyData(res1) || 0;

					const s2 = new Date(start.getTime());
					s2.setHours(fromH, 0, 0, 0);
					const e2 = new Date(start.getTime());
					e2.setHours(24, 0, 0, 0);
					const res2 = await axios.get(
						`https://api.inexogy.com/public/v1/statistics?meterId=${meterId}&from=${s2.getTime()}&to=${e2.getTime()}`,
						{ headers, validateStatus: () => true },
					);
					consumption += this.parseInexogyData(res2) || 0;
				}

				result.slots[rate.name] = { consumption };
				result.total += consumption;
			}

			return result;
		} catch (error) {
			this.log.error(`Inexogy fetch error: ${error.message}`);
			return null;
		}
	}

	async syncData() {
		await this.cleanupLegacyHistory();
		const syncDays = Number(this.config.syncDays) || 30;
		this.log.info(`Starting ${syncDays}-day retroactive data sync...`);

		const masterData = await this.fetchOctopusMasterData();
		if (!masterData) {
			this.log.warn('Aborting sync because master data could not be fetched.');
			return;
		}

		try {
			for (let i = syncDays; i >= 1; i--) {
				const targetDate = new Date();
				targetDate.setDate(targetDate.getDate() - i);
				targetDate.setHours(0, 0, 0, 0);
				const endDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);

				const yearStr = `${targetDate.getFullYear()}`;
				const monthStr = String(targetDate.getMonth() + 1).padStart(2, '0');
				const dayStr = String(targetDate.getDate()).padStart(2, '0');

				const basePathYear = `history.${yearStr}`;
				const basePathMonth = `${basePathYear}.${monthStr}`;
				const basePathDay = `${basePathMonth}.${dayStr}`;

				let isCached = false;
				const checkState = await this.getStateAsync(`${basePathDay}.octopus.dailyConsumption`);
				isCached = !!(checkState && checkState.val !== null && checkState.val !== undefined);

				if (!isCached) {
					this.log.debug(`Syncing data for ${yearStr}-${monthStr}-${dayStr}...`);

					// Create hierarchical folders
					await this.setObjectNotExistsAsync(basePathYear, {
						type: 'channel',
						common: { name: `Year ${yearStr}` },
						native: {},
					});
					await this.setObjectNotExistsAsync(basePathMonth, {
						type: 'channel',
						common: { name: `Month ${yearStr}-${monthStr}` },
						native: {},
					});
					await this.setObjectNotExistsAsync(basePathDay, {
						type: 'channel',
						common: { name: `Day ${yearStr}-${monthStr}-${dayStr}` },
						native: {},
					});

					const octopusData = await this.fetchOctopus(targetDate, endDate);
					let inexogyData = null;
					if (this.hasInexogy) {
						inexogyData = await this.fetchInexogy(targetDate, endDate);
					}

					if (octopusData) {
						await this.writeStateObject(
							`${basePathDay}.octopus.dailyConsumption`,
							'Daily Consumption',
							parseFloat(octopusData.total.toFixed(3)),
						);
						await this.writeStateObject(
							`${basePathDay}.octopus.totalCost`,
							'Total Daily Cost',
							parseFloat(octopusData.totalCost.toFixed(2)),
							'value',
							'number',
							'€',
						);

						for (const [slotName, slotData] of Object.entries(octopusData.slots)) {
							const safeName = slotName.toLowerCase();
							await this.writeStateObject(
								`${basePathDay}.octopus.${safeName}Consumption`,
								`Consumption ${slotName}`,
								parseFloat(slotData.consumption.toFixed(3)),
							);
							await this.writeStateObject(
								`${basePathDay}.octopus.${safeName}Cost`,
								`Cost ${slotName}`,
								parseFloat(slotData.cost.toFixed(2)),
								'value',
								'number',
								'€',
							);
						}

						if (inexogyData) {
							await this.writeStateObject(
								`${basePathDay}.inexogy.dailyConsumption`,
								'Daily Consumption',
								parseFloat(inexogyData.total.toFixed(3)),
							);

							for (const [slotName, slotData] of Object.entries(inexogyData.slots)) {
								const safeName = slotName.toLowerCase();
								await this.writeStateObject(
									`${basePathDay}.inexogy.${safeName}Consumption`,
									`Consumption ${slotName}`,
									parseFloat(slotData.consumption.toFixed(3)),
								);

								const diff = Math.abs(octopusData.slots[slotName].consumption - slotData.consumption);
								await this.writeStateObject(
									`${basePathDay}.comparison.${safeName}Difference`,
									`Difference ${slotName}`,
									parseFloat(diff.toFixed(3)),
								);
							}

							const totalDiff = Math.abs(octopusData.total - inexogyData.total);
							const threshold = Number(this.config.discrepancyThreshold) || 0.1;
							await this.writeStateObject(
								`${basePathDay}.comparison.difference`,
								'Absolute Difference',
								parseFloat(totalDiff.toFixed(3)),
							);
							await this.writeStateObject(
								`${basePathDay}.comparison.hasDiscrepancy`,
								'Has Discrepancy',
								totalDiff >= threshold,
								'indicator',
								'boolean',
							);

							if (totalDiff >= threshold) {
								this.log.warn(
									`Discrepancy for ${yearStr}-${monthStr}-${dayStr}! Diff: ${totalDiff.toFixed(3)} kWh`,
								);
							}
						}
					} else {
						this.log.warn(`Skipping ${yearStr}-${monthStr}-${dayStr} due to missing Octopus data.`);
					}
				}
			}

			// Aggregate hierarchical data
			await this.aggregateHistory();

			// Update JSONs
			await this.updateHistoryJson();

			// 3. Update meter reading
			const lastOfficialReading = await this.fetchOctopusMeterReadings();
			if (lastOfficialReading) {
				let totalSinceLastReading = 0;
				const objectsForSum = await this.getAdapterObjectsAsync();
				const historyPrefixForSum = `${this.namespace}.history.`;

				for (const id of Object.keys(objectsForSum)) {
					if (id.startsWith(historyPrefixForSum)) {
						const relativeId = id.substring(historyPrefixForSum.length);
						const parts = relativeId.split('.');
						// parts = [YYYY, MM, DD, 'octopus', 'dailyConsumption']
						if (parts.length === 5 && parts[3] === 'octopus' && parts[4] === 'dailyConsumption') {
							const year = parseInt(parts[0], 10);
							const month = parseInt(parts[1], 10);
							const day = parseInt(parts[2], 10);
							const stateDate = new Date(year, month - 1, day);

							// If the day is AFTER the official reading day
							if (stateDate > lastOfficialReading.readAt) {
								const consState = await this.getStateAsync(id);
								if (consState && consState.val) {
									totalSinceLastReading += Number(consState.val);
								}
							}
						}
					}
				}

				const calculatedReading = lastOfficialReading.value + totalSinceLastReading;
				await this.writeStateObject(
					'octopus.info.meterReading',
					'Current Calculated Meter Reading',
					parseFloat(calculatedReading.toFixed(3)),
				);
				this.log.info(`Updated calculated meter reading: ${calculatedReading.toFixed(3)} kWh`);
			}
		} catch (error) {
			this.log.error(`Error during syncData: ${error.message}`);
		}
	}

	async aggregateHistory() {
		this.log.debug('Aggregating hierarchical history...');
		const objects = await this.getAdapterObjectsAsync();
		const historyPrefix = `${this.namespace}.history.`;

		const yearMap = {}; // year -> { consumption, cost, months: { month -> { consumption, cost } } }
		let currentMonthTotals = { consumption: 0, cost: 0 };
		const currentY = new Date().getFullYear();
		const currentM = String(new Date().getMonth() + 1).padStart(2, '0');

		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const parts = relativeId.split('.');
				// parts = [YYYY, MM, DD, 'octopus', 'dailyConsumption']
				if (parts.length === 5 && parts[3] === 'octopus' && parts[4] === 'dailyConsumption') {
					const year = parts[0];
					const month = parts[1];

					if (!yearMap[year]) {
						yearMap[year] = { consumption: 0, cost: 0, months: {} };
					}
					if (!yearMap[year].months[month]) {
						yearMap[year].months[month] = { consumption: 0, cost: 0 };
					}

					const consState = await this.getStateAsync(id);
					const costState = await this.getStateAsync(
						`${historyPrefix}${year}.${month}.${parts[2]}.octopus.totalCost`,
					);

					const cons = consState && consState.val ? Number(consState.val) : 0;
					const cost = costState && costState.val ? Number(costState.val) : 0;

					yearMap[year].consumption += cons;
					yearMap[year].cost += cost;
					yearMap[year].months[month].consumption += cons;
					yearMap[year].months[month].cost += cost;

					if (year === String(currentY) && month === currentM) {
						currentMonthTotals.consumption += cons;
						currentMonthTotals.cost += cost;
					}
				}
			}
		}

		for (const [year, yData] of Object.entries(yearMap)) {
			await this.writeStateObject(
				`history.${year}.totalConsumption`,
				`Year ${year} Consumption`,
				parseFloat(yData.consumption.toFixed(3)),
			);
			await this.writeStateObject(
				`history.${year}.totalCost`,
				`Year ${year} Cost`,
				parseFloat(yData.cost.toFixed(2)),
				'value',
				'number',
				'€',
			);

			for (const [month, mData] of Object.entries(yData.months)) {
				await this.writeStateObject(
					`history.${year}.${month}.totalConsumption`,
					`Month ${year}-${month} Consumption`,
					parseFloat(mData.consumption.toFixed(3)),
				);
				await this.writeStateObject(
					`history.${year}.${month}.totalCost`,
					`Month ${year}-${month} Cost`,
					parseFloat(mData.cost.toFixed(2)),
					'value',
					'number',
					'€',
				);
			}
		}

		await this.writeStateObject(
			'octopus.currentMonth.totalConsumption',
			'Current Month Consumption',
			parseFloat(currentMonthTotals.consumption.toFixed(3)),
		);
		await this.writeStateObject(
			'octopus.currentMonth.totalCost',
			'Current Month Cost',
			parseFloat(currentMonthTotals.cost.toFixed(2)),
			'value',
			'number',
			'€',
		);
	}

	async updateHistoryJson() {
		this.log.info('Updating history JSON arrays...');
		const objects = await this.getAdapterObjectsAsync();
		const historyPrefix = `${this.namespace}.history.`;

		const dates = new Set();
		for (const id of Object.keys(objects)) {
			if (id.startsWith(historyPrefix)) {
				const relativeId = id.substring(historyPrefix.length);
				const parts = relativeId.split('.');
				if (
					parts.length >= 3 &&
					/^\d{4}$/.test(parts[0]) &&
					/^\d{2}$/.test(parts[1]) &&
					/^\d{2}$/.test(parts[2])
				) {
					dates.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
				}
			}
		}

		const sortedDates = Array.from(dates).sort();
		const octopusHistory = [];
		const inexogyHistory = [];

		for (const dateStr of sortedDates) {
			const [year, month, day] = dateStr.split('.').map(Number);
			const timestamp = new Date(year, month - 1, day).getTime();
			const basePath = `history.${dateStr}`;

			const dayObj = {
				date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
				timestamp: timestamp,
				total: (await this.getStateAsync(`${basePath}.octopus.dailyConsumption`))?.val || 0,
				totalCost: (await this.getStateAsync(`${basePath}.octopus.totalCost`))?.val || 0,
			};

			if (this.masterData && this.masterData.rates) {
				for (const rate of this.masterData.rates) {
					const name = rate.name.toLowerCase();
					dayObj[name] = (await this.getStateAsync(`${basePath}.octopus.${name}Consumption`))?.val || 0;
					dayObj[`${name}Cost`] = (await this.getStateAsync(`${basePath}.octopus.${name}Cost`))?.val || 0;
				}
			}
			octopusHistory.push(dayObj);

			if (this.hasInexogy) {
				const inxDayObj = {
					date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
					timestamp: timestamp,
					total: (await this.getStateAsync(`${basePath}.inexogy.dailyConsumption`))?.val || 0,
				};

				if (this.masterData && this.masterData.rates) {
					for (const rate of this.masterData.rates) {
						const name = rate.name.toLowerCase();
						inxDayObj[name] =
							(await this.getStateAsync(`${basePath}.inexogy.${name}Consumption`))?.val || 0;
					}
				}
				inexogyHistory.push(inxDayObj);
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
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new EnergyCompare(options);
} else {
	new EnergyCompare();
}
