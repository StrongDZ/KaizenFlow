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
