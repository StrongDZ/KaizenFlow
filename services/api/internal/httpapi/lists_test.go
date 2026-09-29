package httpapi_test

import "testing"

func TestRunsListEndpoint(t *testing.T) {
	a := newAPI(t)
	vid := a.publishedModel("denso-mini")
	_, rid := a.doneRun(vid, "Ca sáng")

	res := a.call("GET", "/api/runs?status=DONE&model=denso-mini", nil, 200)
	items := res["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", items)
	}
	row := items[0].(map[string]any)
	if row["id"].(float64) != float64(rid) || row["scenario_name"] != "Ca sáng" || row["model_key"] != "denso-mini" ||
		row["red_minutes_p50"].(float64) != 3 || row["version"].(float64) != 1 {
		t.Fatalf("row = %v", row)
	}
	// tham số xấu không được làm hỏng (không 500) và không lọc nhầm
	if n := len(a.call("GET", "/api/runs?limit=abc&offset=-5", nil, 200)["items"].([]any)); n != 1 {
		t.Fatalf("bad numbers: %d rows", n)
	}
	if n := len(a.call("GET", "/api/runs?limit=1000", nil, 200)["items"].([]any)); n != 1 {
		t.Fatalf("big limit: %d rows", n)
	}
	if n := len(a.call("GET", "/api/runs?status=BOGUS", nil, 200)["items"].([]any)); n != 0 {
		t.Fatalf("bogus status: %d rows", n)
	}
	if n := len(a.call("GET", "/api/runs?status=QUEUED,RUNNING", nil, 200)["items"].([]any)); n != 0 {
		t.Fatalf("active: %d rows", n)
	}
}

func TestInsightsListEndpoint(t *testing.T) {
	a := newAPI(t)
	vid := a.publishedModel("denso-mini")
	a.doneRun(vid, "Ca sáng")

	items := a.call("GET", "/api/insights?kind=RED_RISK", nil, 200)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", items)
	}
	row := items[0].(map[string]any)
	if row["kind"] != "RED_RISK" || row["model_key"] != "denso-mini" || row["scenario_name"] != "Ca sáng" || row["subject_key"] != "S" {
		t.Fatalf("row = %v", row)
	}
	if n := len(a.call("GET", "/api/insights?limit=abc", nil, 200)["items"].([]any)); n != 2 {
		t.Fatalf("all insights = %d", n)
	}
}

func TestNodeTypeDetailEndpoint(t *testing.T) {
	a := newAPI(t)
	a.publishedModel("denso-mini")

	found := false
	for _, it := range a.call("GET", "/api/node-types", nil, 200)["items"].([]any) {
		row := it.(map[string]any)
		if row["code"] == "RACK_WAREHOUSE" {
			found = true
			if row["used_in_versions"].(float64) != 1 {
				t.Fatalf("row = %v", row)
			}
		}
	}
	if !found {
		t.Fatal("RACK_WAREHOUSE missing from list")
	}
	d := a.call("GET", "/api/node-types/RACK_WAREHOUSE", nil, 200)
	usage := d["usage"].(map[string]any)["versions"].([]any)
	if d["code"] != "RACK_WAREHOUSE" || len(usage) != 1 || usage[0].(map[string]any)["status"] != "PUBLISHED" {
		t.Fatalf("detail = %v", d)
	}
	a.call("GET", "/api/node-types/NOPE", nil, 404)
}

func TestMaterialDetailEndpoint(t *testing.T) {
	a := newAPI(t)
	a.publishedModel("denso-mini")

	for _, it := range a.call("GET", "/api/materials", nil, 200)["items"].([]any) {
		row := it.(map[string]any)
		if row["code"] == "RAW-01" && row["used_in_versions"].(float64) != 1 {
			t.Fatalf("row = %v", row)
		}
	}
	d := a.call("GET", "/api/materials/RAW-01", nil, 200)
	usage := d["usage"].(map[string]any)
	if d["code"] != "RAW-01" || len(usage["edges"].([]any)) != 2 || len(usage["nodes"].([]any)) != 2 {
		t.Fatalf("detail = %v", d)
	}
	a.call("GET", "/api/materials/NOPE", nil, 404)
}
