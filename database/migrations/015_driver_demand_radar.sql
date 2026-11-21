-- Driver "Demand Radar": lets the demand query scan recent pickups by time + location quickly.

CREATE INDEX idx_ride_demand
ON rides(created_at, pickup_lat, pickup_lng);
