import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "scratch" / "demo_video" / "screens"
BASE_URL = os.environ.get("DEMO_BASE_URL", "http://127.0.0.1:5000/")
VIEWPORT = {"width": 1920, "height": 1080}


REPLACEMENTS = {
    "â€”": "—",
    "â€“": "–",
    "â€˜": "'",
    "â€™": "'",
    "â€œ": '"',
    "â€": '"',
    "â€¦": "...",
    "â‰¤": "≤",
    "â‰¥": "≥",
    "âœ•": "×",
    "ðŸ—“": "Calendar",
    "ðŸ“Š": "Chart",
    "ðŸš€": "",
    "ðŸ› ï¸": "",
    "ðŸ“": "",
    "ðŸ“ˆ": "",
}


SCENES = [
    {
        "name": "01_home",
        "title": "DAA Workforce",
        "caption": "A single workspace for passenger demand, staffing capacity, and live resource planning.",
    },
    {
        "name": "02_long_term_forecast",
        "view": "long-term",
        "title": "Strategic 12-Month Forecast",
        "caption": "Annual passenger and flight forecasts show the demand signal that drives resource planning.",
    },
    {
        "name": "03_capacity_heatmap",
        "view": "long-term",
        "scroll": 520,
        "title": "Capacity Hotspots",
        "caption": "Weekly heatmaps surface high-demand periods, utilisation risk, and seasonal pressure points.",
    },
    {
        "name": "04_workforce_plan",
        "view": "long-term",
        "sub": "allocation",
        "title": "Workforce Plan",
        "caption": "Role and terminal allocation converts the forecast into actionable staffing requirements.",
    },
    {
        "name": "05_roster_pattern",
        "view": "long-term",
        "sub": "four-week-roster",
        "title": "Four-Week Roster Pattern",
        "caption": "Shift templates show how weekly demand becomes practical staff coverage across the operation.",
    },
    {
        "name": "06_scenario_planning",
        "view": "long-term",
        "sub": "scenario",
        "title": "Scenario Planning",
        "caption": "Monte Carlo stress testing helps compare demand surges, absence levels, and resilience options.",
    },
    {
        "name": "07_short_term_summary",
        "view": "short-term",
        "title": "Three-Day Tactical View",
        "caption": "The rolling short-term view highlights near-term demand, alerts, and coverage by skill.",
    },
    {
        "name": "08_task_allocation",
        "view": "short-term",
        "sttab": "staff-timeline",
        "title": "Task Allocation",
        "caption": "The operational timeline maps staff assignments, breaks, and coverage windows for the selected day.",
    },
    {
        "name": "09_short_term_optimisation",
        "view": "short-term",
        "sttab": "opt",
        "title": "Optimisation Controls",
        "caption": "Managers can tune travel time, shift stability, and secondary-skill preferences before optimising.",
    },
    {
        "name": "10_intraday_reallocation",
        "view": "intraday",
        "idtab": "opt",
        "title": "Live Staff Reallocation",
        "caption": "Intraday heatmaps expose gaps by skill and time block, then recommend eligible staff moves.",
    },
    {
        "name": "11_intraday_timeline",
        "view": "intraday",
        "idtab": "staff-timeline",
        "title": "Live Roster Timeline",
        "caption": "The live timeline keeps assignments, breaks, and shift coverage visible throughout the day.",
    },
    {
        "name": "12_intraday_pax_demand",
        "view": "intraday",
        "idtab": "demand",
        "title": "Passenger Demand Pulse",
        "caption": "Fifteen-minute passenger signals show how touchpoint demand changes across terminals and roles.",
    },
    {
        "name": "13_config",
        "view": "config",
        "title": "Configurable Assumptions",
        "caption": "PAX productivity rates and staff skills can be updated, then reflected across every planning layer.",
    },
]


def wait_settle(page, ms=2200):
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(ms)
    clean_text(page)


def clean_text(page):
    # The source files contain a few mojibake sequences. Clean the DOM for
    # presentation-only capture without changing app source files.
    page.evaluate(
        """(pairs) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (const node of nodes) {
                let value = node.nodeValue;
                for (const [bad, good] of pairs) value = value.split(bad).join(good);
                node.nodeValue = value;
            }
            document.title = document.title.replaceAll('â€”', '—');
        }""",
        list(REPLACEMENTS.items()),
    )


def click_if_visible(page, selector, timeout=9000):
    loc = page.locator(selector).first
    loc.wait_for(state="visible", timeout=timeout)
    loc.click()
    wait_settle(page)


def capture_scene(page, scene):
    if scene.get("view"):
        click_if_visible(page, f'[data-view="{scene["view"]}"]')

    if scene.get("sub"):
        click_if_visible(page, f'button[data-sub="{scene["sub"]}"]')

    if scene.get("sttab"):
        click_if_visible(page, f'button[data-sttab="{scene["sttab"]}"]', timeout=12000)

    if scene.get("idtab"):
        click_if_visible(page, f'button[data-idtab="{scene["idtab"]}"]', timeout=12000)

    y = scene.get("scroll", 0)
    page.evaluate("(y) => window.scrollTo(0, y)", y)
    wait_settle(page, 1800)

    path = OUT / f"{scene['name']}.png"
    page.screenshot(path=str(path), full_page=False)
    return {
        "file": path.name,
        "title": scene["title"],
        "caption": scene["caption"],
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    metadata = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport=VIEWPORT,
            device_scale_factor=1,
            record_video_dir=None,
            ignore_https_errors=True,
        )
        page = context.new_page()
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
        page.add_style_tag(
            content="""
                * { scroll-behavior: auto !important; }
                body { cursor: default !important; }
                .app-header { backdrop-filter: blur(16px); }
            """
        )
        wait_settle(page, 4000)

        for scene in SCENES:
            try:
                metadata.append(capture_scene(page, scene))
                print(f"captured {scene['name']}")
            except Exception as exc:
                print(f"FAILED {scene['name']}: {exc}")

        browser.close()

    meta_path = OUT.parent / "scene_metadata.json"
    import json

    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"wrote {meta_path}")


if __name__ == "__main__":
    main()
