# AeroSched: DAA Ground Operations Staff Planning Platform

AeroSched is an advanced, intelligence-driven operations platform designed for the **DAA (Dublin Airport Authority)** to manage ground operations staffing. It provides a three-tiered approach to resource management: Strategic (Long-Term), Tactical (Short-Term), and Operational (Real-Time/Intraday).

## 🚀 Overview

AeroSched transforms flight forecast data and staff availability into actionable schedules. It helps operations managers predict staffing gaps, optimize rosters, and respond to real-time disruptions like flight delays and cancellations.

## ✨ Key Features

### 1. Strategic Planning (Long-Term)
*   **12-Month Forecast**: Visualize seasonal trends and annual flight volumes for 2026.
*   **Gap Analysis**: Automatically identify weeks where staff demand exceeds available capacity.
*   **Annual Allocation**: Detailed breakdown of FTE requirements by role (GNIB, CBP, Ramp, etc.) and airport pier.
*   **Scenario Planning**: Perform **Monte Carlo simulations** to stress-test your workforce against demand surges, punctuality drops, and staff absence rates.

### 2. Tactical Planning (Short-Term)
*   **3-Day Rolling Window**: Manage detailed scheduling for the upcoming 3 days.
*   **Task Generation**: Automatically decomposes flight movements into specific tasks (Bussing, Marshalling, Immigration) based on complex rules defined in `Config.csv`.
*   **Staff Roster**: View assignments, break schedules, and individual utilization rates.
*   **Gate Timeline**: A high-level visual Gantt chart of flight occupancy across all contact and remote stands.

### 3. Live Operations (Intraday)
*   **Real-Time Optimization**: A live view of today's operations with current time indicators.
*   **Disruption Management**: Apply delays or cancellations to flights and watch the system re-calculate task timings and staff assignments instantly.
*   **Manual Overrides**: Drag-and-drop staff onto tasks to cover last-minute gaps.

## 🛠️ Technology Stack

*   **Backend**: Python / Flask
*   **Frontend**: Vanilla JavaScript (ES6+), Modern CSS (Glassmorphism aesthetics)
*   **Charting**: Chart.js for high-performance data visualization.
*   **Simulation**: Custom Monte Carlo engine for risk modeling.

## 📁 Data Structure

The application is powered by a set of CSV files located in the `data/` directory:

| File | Description |
| :--- | :--- |
| `forecast_pax_results_2026.csv` | Weekly P10/P50/P90 passenger forecast used for the long-term view. |
| `historical_pax_data.csv` | Historical weekly passenger footfall used for actuals in the long-term trend chart. |
| `Flights_schedule_4days.csv` | Tactical flight movement data for the next 4 days. |
| `Staff_schedule.csv` | Daily roster showing which staff members are on duty. |
| `Staff_absence_schedule.csv` | Tracks approved leave and sickness. |
| `Config.csv` | The "brain" of the system—contains rules for task offsets, durations, and staff requirements. |
| `Stands.csv` | Mapping of gates to terminals, piers, and stand types (Contact vs. Remote). |

> [!NOTE]
> The platform includes **Self-Healing Data Automation**. On startup, the app automatically updates operational schedule dates to the current day.

## 🚦 Getting Started

### Prerequisites
*   Python 3.8+

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

## 📈 Methodology

Staffing requirements are calculated using a **calibrated FTE model**. For long-term forecasting, the system uses weekly `P50_Pax` footfall from `forecast_pax_results_2026.csv`, applies passenger-handling rates from `PAX Config.xlsx`, and converts those passenger-slots into FTEs.

---
*Created for DAA Ground Operations — Operational Excellence through Intelligence.*
