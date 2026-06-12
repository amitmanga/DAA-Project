# AeroSched: DAA Ground Operations Staff Planning Platform

## About

AeroSched is an intelligence-driven operations platform designed for **DAA (Dublin Airport Authority)** to manage ground operations staffing. It provides a three-tiered approach to resource management: Strategic (Long-Term), Tactical (Short-Term), and Operational (Real-Time/Intraday).

AeroSched transforms passenger forecast data and staff availability into actionable schedules. It helps operations managers predict staffing gaps, optimize rosters, and respond to real-time operational changes.

## Demo Video

<video src="scratch/demo_video/DAA_AeroSched_3min_demo.mp4" controls width="100%">
  Your browser does not support embedded video playback. Open the demo video at scratch/demo_video/DAA_AeroSched_3min_demo.mp4.
</video>

[Open the 3-minute demo video](scratch/demo_video/DAA_AeroSched_3min_demo.mp4)

## Key Features

### 1. Strategic Planning (Long-Term)

* **12-Month Forecast**: Visualize seasonal trends and annual passenger footfall for 2026.
* **Gap Analysis**: Automatically identify weeks where staff demand exceeds available capacity.
* **Annual Allocation**: Detailed breakdown of FTE requirements by role, terminal, and airport pier.
* **Scenario Planning**: Perform Monte Carlo simulations to stress-test workforce plans against demand surges, punctuality drops, and staff absence rates.

### 2. Tactical Planning (Short-Term)

* **3-Day Rolling Window**: Manage detailed scheduling for the upcoming 3 days.
* **Task Generation**: Convert passenger demand profiles into staffing tasks for passenger-processing roles.
* **Staff Roster**: View assignments, break schedules, and individual utilization rates.
* **Demand Timeline**: Review passenger-driven staffing demand by touchpoint and time block.

### 3. Live Operations (Intraday)

* **Real-Time Optimization**: Monitor today's operations with current time indicators.
* **Disruption Management**: Adjust operational assumptions and recalculate task timings and staff assignments.
* **Manual Overrides**: Reallocate staff onto tasks to cover last-minute gaps.

## Technology Stack

* **Backend**: Python / Flask
* **Frontend**: Vanilla JavaScript (ES6+), modern CSS
* **Charting**: Chart.js for high-performance data visualization
* **Optimization**: MIP and CP-SAT workforce allocation workflows
* **Simulation**: Custom Monte Carlo engine for risk modeling

## Data Structure

The application is powered by a set of CSV and Excel files located in the `data/` directory:

| File | Description |
| :--- | :--- |
| `forecast_pax_results_2026.csv` | Weekly P10/P50/P90 passenger forecast used for the long-term view. |
| `historical_pax_data.csv` | Historical weekly passenger footfall used for actuals in the long-term trend chart. |
| `Staff_schedule.csv` | Daily roster showing which staff members are on duty. |
| `Staff_absence_schedule.csv` | Tracks approved leave and sickness. |
| `short term PAX.xlsx` | Short-term passenger demand profile used for tactical and intraday staffing. |
| `PAX Config.xlsx` | Passenger-handling productivity rates used to convert footfall into staffing demand. |

> [!NOTE]
> The platform includes self-healing data automation. On startup, the app automatically updates operational schedule dates to the current day.

## Getting Started

### Prerequisites

* Python 3.8+

### Installation

1. Clone the repository.
2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Run the application:

   ```bash
   python app.py
   ```

4. Open your browser and navigate to `http://127.0.0.1:5000`.

## Methodology

Staffing requirements are calculated using a calibrated FTE model. For long-term forecasting, the system uses weekly `P50_Pax` footfall from `forecast_pax_results_2026.csv`, applies passenger-handling rates from `PAX Config.xlsx`, and converts those passenger slots into FTEs.

---

Created for DAA Ground Operations: Operational Excellence through Intelligence.
