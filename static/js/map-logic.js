/**
 * RouteMapManager
 * Handles Leaflet initialization for DAA Route Maps across tabs.
 */
class RouteMapManager {
    constructor(containerId, options = {}) {
        this.containerId = containerId;
        this.options = Object.assign({
            center: [50, -5],
            zoom: 4,
            theme: 'dark'
        }, options);
        
        this.map = null;
        this.layers = {
            base: L.layerGroup(),
            routes: L.layerGroup(),
            airports: L.layerGroup()
        };
        this.data = null;
        this.init();
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        this.map = L.map(this.containerId, {
            center: this.options.center,
            zoom: this.options.zoom,
            zoomControl: false,
            attributionControl: false
        });

        // Add zoom control to bottom right
        L.control.zoom({ position: 'bottomright' }).addTo(this.map);

        // Light theme tiles (matching AeroSched light theme)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(this.map);

        this.layers.routes.addTo(this.map);
        this.layers.airports.addTo(this.map);

        // Dublin Base Marker
        const dub = AIRPORT_COORDS["DUB"];
        if (dub) {
            L.circleMarker([dub.lat, dub.lon], {
                radius: 7,
                fillColor: '#f97316', // Accent color
                color: '#1a2744',     // Navy border
                weight: 2,
                opacity: 1,
                fillOpacity: 1
            }).addTo(this.map).bindTooltip("Dublin Airport (DUB)", { permanent: false, direction: 'top' });
        }
    }

    async loadData(apiUrl) {
        try {
            const resp = await fetch(apiUrl);
            this.data = await resp.json();
            this.render();
        } catch (e) {
            console.error("Map data load failed:", e);
        }
    }

    render() {
        if (!this.data) return;
        this.layers.routes.clearLayers();
        this.layers.airports.clearLayers();

        const dub = AIRPORT_COORDS["DUB"];
        if (!dub) return;

        const { arrivals, departures } = this.data;
        const airportsShown = new Set();

        const drawRoute = (code, count, type) => {
            const dest = AIRPORT_COORDS[code];
            if (!dest) return;
            
            airportsShown.add(code);
            // Unified styling: Navy for arrivals, Orange for departures (or just navy for both for simplicity)
            const color = type === 'arrival' ? '#1a2744' : '#f97316';
            const weight = Math.min(Math.max(count / 2, 1.2), 5);
            
            // Draw line
            const line = L.polyline([[dub.lat, dub.lon], [dest.lat, dest.lon]], {
                color: color,
                weight: weight,
                opacity: 0.3,
                className: 'route-line'
            }).addTo(this.layers.routes);
        };

        // Always show both
        Object.entries(arrivals).forEach(([code, count]) => drawRoute(code, count, 'arrival'));
        Object.entries(departures).forEach(([code, count]) => drawRoute(code, count, 'departure'));

        // Draw airport markers
        airportsShown.forEach(code => {
            const dest = AIRPORT_COORDS[code];
            if (!dest) return;

            const arrCount = arrivals[code] || 0;
            const depCount = departures[code] || 0;
            const total = arrCount + depCount;

            const radius = Math.min(Math.max(Math.sqrt(total) * 2, 3), 10);
            
            const marker = L.circleMarker([dest.lat, dest.lon], {
                radius: radius,
                fillColor: '#1a2744',
                color: '#fff',
                weight: 1,
                opacity: 0.9,
                fillOpacity: 0.8
            }).addTo(this.layers.airports);

            const tooltipHtml = `
                <div class="map-tooltip">
                    <div class="map-tooltip-title">${dest.name} (${code})</div>
                    <div class="map-tooltip-body">
                        <div class="map-tt-row"><span class="arr-dot"></span> Arrivals: <b>${arrCount}</b></div>
                        <div class="map-tt-row"><span class="dep-dot"></span> Departures: <b>${depCount}</b></div>
                    </div>
                </div>
            `;
            marker.bindTooltip(tooltipHtml, { sticky: true, className: 'leaflet-tooltip-custom' });
        });

        // Adjust view to fit all routes if visible
        if (airportsShown.size > 0) {
            // this.map.fitBounds(this.layers.routes.getBounds(), { padding: [20, 20] });
        }
    }
}
