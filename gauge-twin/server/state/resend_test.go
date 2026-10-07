package main

import (
	"testing"
)

func TestSeqRangesGroupsConsecutiveNumbersAndSplitsAtTheRequestLimit(t *testing.T) {
	got := seqRanges([]uint64{3, 4, 5, 9, 11, 12})
	want := [][2]uint64{{3, 5}, {9, 9}, {11, 12}}
	if len(got) != len(want) {
		t.Fatalf("ranges: %v", got)
	}
	for i, w := range want {
		if got[i].FromSeq != w[0] || got[i].ToSeq != w[1] {
			t.Errorf("range %d: %d-%d, want %d-%d", i, got[i].FromSeq, got[i].ToSeq, w[0], w[1])
		}
	}

	long := make([]uint64, maxResendRange+5)
	for i := range long {
		long[i] = uint64(100 + i)
	}
	split := seqRanges(long)
	if len(split) != 2 || split[0].ToSeq-split[0].FromSeq+1 != maxResendRange || split[1].FromSeq != split[0].ToSeq+1 ||
		split[1].ToSeq != long[len(long)-1] {
		t.Errorf("split: %v", split)
	}
	if seqRanges(nil) != nil {
		t.Error("no numbers must give no ranges")
	}
}
