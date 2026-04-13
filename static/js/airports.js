/**
 * Airport Coordinates Mapping
 * Used for the Leaflet Route Map visualizations.
 */
const AIRPORT_COORDS = {
    // Dublin (Base)
    "DUB": { name: "Dublin Airport", lat: 53.4213, lon: -6.2701 },
    
    // London
    "LHR": { name: "London Heathrow", lat: 51.4700, lon: -0.4543 },
    "LGW": { name: "London Gatwick", lat: 51.1481, lon: -0.1903 },
    "STN": { name: "London Stansted", lat: 51.8850, lon: 0.2350 },
    "LTN": { name: "London Luton", lat: 51.8747, lon: -0.3683 },
    "LCY": { name: "London City", lat: 51.5053, lon: 0.0553 },
    
    // UK
    "MAN": { name: "Manchester", lat: 53.3556, lon: -2.2747 },
    "EDI": { name: "Edinburgh", lat: 55.9500, lon: -3.3725 },
    "BHX": { name: "Birmingham", lat: 52.4539, lon: -1.7480 },
    "GLA": { name: "Glasgow", lat: 55.8719, lon: -4.4331 },
    "BRS": { name: "Bristol", lat: 51.3827, lon: -2.7191 },
    "LBA": { name: "Leeds Bradford", lat: 53.8681, lon: -1.6606 },
    "LPL": { name: "Liverpool", lat: 53.3339, lon: -2.8500 },
    "NCL": { name: "Newcastle", lat: 55.0375, lon: -1.6917 },
    "EMA": { name: "East Midlands", lat: 52.8311, lon: -1.3281 },
    "SOU": { name: "Southampton", lat: 50.9503, lon: -1.3572 },
    "ABZ": { name: "Aberdeen", lat: 57.2025, lon: -2.1964 },
    
    // Europe
    "AMS": { name: "Amsterdam", lat: 52.3086, lon: 4.7639 },
    "CDG": { name: "Paris Charles de Gaulle", lat: 49.0097, lon: 2.5479 },
    "ORY": { name: "Paris Orly", lat: 48.7262, lon: 2.3652 },
    "BVA": { name: "Beauvais", lat: 49.4544, lon: 2.1128 },
    "FRA": { name: "Frankfurt", lat: 50.0333, lon: 8.5706 },
    "MUC": { name: "Munich", lat: 48.3537, lon: 11.7861 },
    "BER": { name: "Berlin", lat: 52.3667, lon: 13.5033 },
    "DUS": { name: "Dusseldorf", lat: 51.2895, lon: 6.7668 },
    "MAD": { name: "Madrid", lat: 40.4839, lon: -3.5680 },
    "BCN": { name: "Barcelona", lat: 41.2974, lon: 2.0833 },
    "AGP": { name: "Malaga", lat: 36.6749, lon: -4.4991 },
    "ALC": { name: "Alicante", lat: 38.2822, lon: -0.5582 },
    "PMI": { name: "Palma de Mallorca", lat: 39.5517, lon: 2.7388 },
    "LIS": { name: "Lisbon", lat: 38.7742, lon: -9.1342 },
    "FAO": { name: "Faro", lat: 37.0144, lon: -7.9657 },
    "FCO": { name: "Rome Fiumicino", lat: 41.8003, lon: 12.2389 },
    "MXP": { name: "Milan Malpensa", lat: 45.6300, lon: 8.7231 },
    "BGY": { name: "Bergamo", lat: 45.6685, lon: 9.6978 },
    "BRU": { name: "Brussels", lat: 50.9010, lon: 4.4844 },
    "CPH": { name: "Copenhagen", lat: 55.6180, lon: 12.6508 },
    "ZRH": { name: "Zurich", lat: 47.4581, lon: 8.5481 },
    "VIE": { name: "Vienna", lat: 48.1103, lon: 16.5697 },
    "IST": { name: "Istanbul", lat: 41.2753, lon: 28.7519 },
    "ARN": { name: "Stockholm", lat: 59.6498, lon: 17.9238 },
    "PRG": { name: "Prague", lat: 50.1008, lon: 14.2600 },
    
    // North America (TA / CBP)
    "JFK": { name: "New York JFK", lat: 40.6413, lon: -73.7781 },
    "EWR": { name: "Newark", lat: 40.6895, lon: -74.1745 },
    "BOS": { name: "Boston Logan", lat: 42.3656, lon: -71.0096 },
    "IAD": { name: "Washington Dulles", lat: 38.9531, lon: -77.4565 },
    "ORD": { name: "Chicago O'Hare", lat: 41.9742, lon: -87.9073 },
    "YYZ": { name: "Toronto Pearson", lat: 43.6777, lon: -79.6248 },
    "SFO": { name: "San Francisco", lat: 37.6190, lon: -122.3748 },
    "LAX": { name: "Los Angeles", lat: 33.9416, lon: -118.4085 },
    "MCO": { name: "Orlando", lat: 28.4294, lon: -81.3089 },
    
    // Others / Domestic / Tourism
    "ACE": { name: "Lanzarote", lat: 28.9455, lon: -13.6052 },
    "TFS": { name: "Tenerife South", lat: 28.0445, lon: -16.5725 },
    "FUE": { name: "Fuerteventura", lat: 28.4527, lon: -13.8638 },
    "LPA": { name: "Gran Canaria", lat: 27.9319, lon: -15.3866 },
    "ORK": { name: "Cork", lat: 51.8413, lon: -8.4911 },
    "SNN": { name: "Shannon", lat: 52.7019, lon: -8.9247 },
    "CFN": { name: "Donegal", lat: 55.0067, lon: -8.3372 },
    "KIR": { name: "Kerry", lat: 52.1819, lon: -9.5233 }
};
