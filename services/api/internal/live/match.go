package live

import "strings"

// MatchSource khớp nguồn với mẫu kiểu MQTT: `+` một cấp, `#` phần còn lại (chỉ ở cuối).
func MatchSource(pattern, source string) bool {
	if pattern == "" {
		return false
	}
	p := strings.Split(pattern, "/")
	s := strings.Split(source, "/")
	for i, seg := range p {
		if seg == "#" {
			return i == len(p)-1
		}
		if i >= len(s) {
			return false
		}
		if seg != "+" && seg != s[i] {
			return false
		}
	}
	return len(p) == len(s)
}
