package sim

// Buffer is the in-memory offline buffer of one edge: a bounded FIFO that
// drops the oldest message when full. It is used from a single goroutine.
type Buffer struct {
	items []*item
	max   int
	bytes int
}

func NewBuffer(max int) *Buffer { return &Buffer{max: max} }

// Push appends a message and returns the message dropped to make room, if any.
func (b *Buffer) Push(it *item) (dropped *item) {
	if len(b.items) >= b.max {
		dropped = b.Pop()
	}
	b.items = append(b.items, it)
	b.bytes += it.size
	return dropped
}

// PushFront puts back a message that was taken out but could not be sent.
func (b *Buffer) PushFront(it *item) {
	b.items = append([]*item{it}, b.items...)
	b.bytes += it.size
}

// Pop removes and returns the oldest message, or nil when empty.
func (b *Buffer) Pop() *item {
	if len(b.items) == 0 {
		return nil
	}
	it := b.items[0]
	b.items[0] = nil
	b.items = b.items[1:]
	b.bytes -= it.size
	return it
}

func (b *Buffer) Len() int   { return len(b.items) }
func (b *Buffer) Bytes() int { return b.bytes }
