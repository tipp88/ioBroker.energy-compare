![Logo](admin/octopus-energy-monitor.svg?v=3)
# ioBroker.octopus-energy-monitor

[![NPM version](https://img.shields.io/npm/v/iobroker.octopus-energy-monitor.svg)](https://www.npmjs.com/package/iobroker.octopus-energy-monitor)
[![Downloads](https://img.shields.io/npm/dm/iobroker.octopus-energy-monitor.svg)](https://www.npmjs.com/package/iobroker.octopus-energy-monitor)
![Number of Installations](https://iobroker.live/badges/octopus-energy-monitor-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/octopus-energy-monitor-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.octopus-energy-monitor.png?downloads=true)](https://nodei.co/npm/iobroker.octopus-energy-monitor/)

**Tests:** ![Test and Release](https://github.com/tipp88/ioBroker.octopus-energy-monitor/workflows/Test%20and%20Release/badge.svg)

## ioBroker.octopus-energy-monitor

The **Octopus Energy Monitor** adapter periodically fetches daily electricity consumption data from **Octopus Energy (Kraken API)** and **Inexogy (Discovergy/Statistics API)**, saving it automatically within your ioBroker object tree.

Its key purpose is identifying discrepancies in billing/measurement between your intelligent smart meter (Inexogy) and your energy supplier (Octopus Energy). Every night, the adapter compares both datasets and flags daily discrepancies that exceed a configurable threshold mathematically.

### 🌟 Features
* **Full Kraken GraphQL Support:** Authenticates via your Octopus JWT tokens and dynamically resolves account properties to fetch precise consumption data.
* **Dynamic Tariff & Slot Support:** Automatically detects your active Octopus tariff (e.g., Intelligent Octopus Go) and its specific time-of-use slots. No manual configuration of "Go" hours needed!
* **Automated Cost Calculation:** Automatically calculates daily, monthly, and yearly energy costs in **Euro (€)** based on your actual tariff rates.
* **Hierarchical History:** Structures data in a clean `history.YYYY.MM.DD` tree with automatic aggregation of consumption and costs for months and years.
* **Estimated Meter Reading:** Calculates your current electricity meter reading by combining the latest official Kraken reading with your subsequent daily consumptions.
* **Inexogy (Discovergy) Comparison:** Leverages the Inexogy API to compare consumption data against your provider's data, helping identify billing discrepancies.
* **Master Data Insight:** Provides transparency into your account balance, meter details, and involved network operators (MOP/DNO).
* **Smart Caching:** Minimizes API load by retroactively syncing only missing data points (30-day default).

---

### ⚙️ Installation

To install this adapter seamlessly into your ioBroker environment:

1. Open your ioBroker Admin UI in the browser.
2. Ensure Expert Mode is enabled (headman icon).
3. Navigate to **"Adapters"**.
4. Click the GitHub / Custom URL icon ("Install from custom URL").
5. Switch to the **Custom** tab and paste the raw GitHub repository URL:
   `https://github.com/tipp88/ioBroker.octopus-energy-monitor`
6. Click install. Once downloaded, create a new instance (the little `+` button).

---

### 🔧 Configuration

1. **Octopus Energy (Kraken):** 
   - Enter your standard Octopus login credentials (Email & Password).
   - Input your Account Number (usually starts with `A-`).
   - *(Optional)* Property ID: If Kraken refuses to dynamically match your `propertyId`, you can explicitly set it here to hard-override the Graph query.
   
2. **Inexogy:**
   - Enter your Inexogy portal Email & Password. The adapter automatically manages Basic Auth parsing and translates it into Discovergy API queries.

3. **General Settings:**
   - **Discrepancy Threshold:** Defines how many `kWh` difference must be present between Octopus and Inexogy to trigger the `hasDiscrepancy: true` state flag. Default is `0.1 kWh`.

Once configured, the adapter handles the rest! It sets an internal Cronjob scaling back 30 days every night. Data manifests under the `octopus-energy-monitor.0.history.YYYY.MM.DD` path.

## Changelog
### **WORK IN PROGRESS**
* (tipp88) Fixed Inexogy data syncing when Octopus data already exists.

### 0.4.1 (2026-05-05)
* (tipp88) Fixed missing meter ID in master data fetch.
* (tipp88) Fixed GraphQL variable type for meter readings (Date vs DateTime).

### 0.4.0 (2026-05-05)
* (tipp88) Implement estimated meter reading calculation based on official Kraken data.

### 0.3.2 (2026-05-05)
* (tipp88) Include dynamic slot consumption and cost in history JSON.

### 0.3.1 (2026-05-05)
* (tipp88) Fix linting errors and repository structure.

### 0.3.0 (2026-05-05)
* (tipp88) Implement dynamic tariffs, hierarchical history, and master data fetch.

### 0.2.3 (2026-05-05)
* (tipp88) Updated adapter logo and icon.

### 0.2.2 (2026-05-05)
* (tipp88) Renamed adapter to ioBroker.octopus-energy-monitor

### 0.2.1 (2026-05-05)
* (tipp88) Fixed adapter checker warnings and errors.

### 0.2.0 (2026-04-23)
* (tipp88) Added data retention setting and aggregated history JSON states.

### 0.1.0 (2026-04-23)
* (tipp88) Initial release with 30-day API cache sweep and deep property introspection.

## License
MIT License

Copyright (c) 2026 tipp88

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.