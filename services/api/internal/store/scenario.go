package store

import "time"

type Scenario struct {
	ID             int64            `json:"id"`
	ModelVersionID int64            `json:"model_version_id"`
	ParentID       *int64           `json:"parent_id"`
	Origin         string           `json:"origin"`
	Name           string           `json:"name"`
	HorizonS       float64          `json:"horizon_s"`
	StartState     string           `json:"start_state"`
	Overrides      []map[string]any `json:"overrides"`
	Injections     []map[string]any `json:"injections"`
	Action         map[string]any   `json:"action"`
	Replications   int              `json:"replications"`
	Seed           *int64           `json:"seed"`
	CreatedAt      time.Time        `json:"created_at"`
}

// DailyPoint là một điểm dự báo nhu cầu theo ngày (forecast_band, metric demand_daily).
type DailyPoint struct {
	Day time.Time
	P50 float64
}
