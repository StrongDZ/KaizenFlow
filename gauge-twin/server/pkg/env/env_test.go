package env

import (
	"reflect"
	"testing"
	"time"
)

func TestFallbacksAndParsing(t *testing.T) {
	t.Setenv("T_STR", "x")
	t.Setenv("T_LIST", " a, b ,,c ")
	t.Setenv("T_INT", "42")
	t.Setenv("T_DUR", "1500ms")
	t.Setenv("T_BAD", "nope")

	if String("T_STR", "d") != "x" || String("T_MISSING", "d") != "d" {
		t.Error("String")
	}
	if got := Strings("T_LIST", nil); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("Strings: %v", got)
	}
	if got := Strings("T_MISSING", []string{"z"}); !reflect.DeepEqual(got, []string{"z"}) {
		t.Errorf("Strings fallback: %v", got)
	}
	if n, err := Int("T_INT", 1); err != nil || n != 42 {
		t.Errorf("Int: %d %v", n, err)
	}
	if n, err := Int("T_MISSING", 7); err != nil || n != 7 {
		t.Errorf("Int fallback: %d %v", n, err)
	}
	if _, err := Int("T_BAD", 1); err == nil {
		t.Error("Int accepted a malformed value")
	}
	if d, err := Duration("T_DUR", time.Second); err != nil || d != 1500*time.Millisecond {
		t.Errorf("Duration: %v %v", d, err)
	}
	if _, err := Duration("T_BAD", time.Second); err == nil {
		t.Error("Duration accepted a malformed value")
	}
}
