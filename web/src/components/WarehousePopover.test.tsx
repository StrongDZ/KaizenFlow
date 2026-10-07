// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { WarehousePopover, type WarehouseSkuRow } from './WarehousePopover'

function run(rows: WarehouseSkuRow[], title = 'Kho test') {
  const html = renderToString(
    <WarehousePopover
      open
      onOpenChange={() => {}}
      anchorX={100}
      anchorY={200}
      title={title}
      rows={rows}
    />,
  )
  return html
}

describe('WarehousePopover', () => {
  it('render header 4 cột và dữ liệu 2 SKU với đúng số', () => {
    const rows: WarehouseSkuRow[] = [
      { sku: 'SKU_A', max: 1000, current: 650 },
      { sku: 'SKU_B', max: 500, current: 80 },
    ]
    const html = run(rows, 'Kho thành phẩm')
    expect(html).toContain('SKU')
    expect(html).toContain('Sức chứa tối đa')
    expect(html).toContain('Tồn kho hiện tại')
    expect(html).toContain('Tình trạng')
    expect(html).toContain('SKU_A')
    expect(html).toContain('1000')
    expect(html).toContain('650')
    expect(html).toContain('SKU_B')
    expect(html).toContain('500')
    expect(html).toContain('80')
    expect(html).toContain('Kho thành phẩm')
  })

  it('render badge màu Đỏ khi stock quá thấp (≤12%) hoặc quá cao (≥92%)', () => {
    const rows: WarehouseSkuRow[] = [
      { sku: 'LOW', max: 100, current: 5 },
      { sku: 'HIGH', max: 100, current: 98 },
    ]
    const html = run(rows)
    expect(html).toContain('bg-bad-bg')
    expect(html).toContain('bg-bad')
    expect(html).toContain('LOW')
    expect(html).toContain('HIGH')
  })

  it('render badge màu Xanh khi stock hợp lý', () => {
    const rows: WarehouseSkuRow[] = [
      { sku: 'OK', max: 100, current: 55 },
    ]
    const html = run(rows)
    expect(html).toContain('bg-ok-bg')
    expect(html).toContain('bg-ok')
  })

  it('render badge màu Vàng khi hơi ít hoặc hơi nhiều', () => {
    const rows: WarehouseSkuRow[] = [
      { sku: 'YELLOW_LOW', max: 100, current: 20 },
      { sku: 'YELLOW_HIGH', max: 100, current: 85 },
    ]
    const html = run(rows)
    expect(html).toContain('bg-warn-bg')
    expect(html).toContain('bg-warn')
  })

  it('render thông báo rỗng khi không có dòng SKU', () => {
    const html = run([])
    expect(html).toContain('chưa khai báo vật tư')
  })

  it('dùng coverageH để tính màu badge khi có coverage thay vì % fill', () => {
    const green = run([{ sku: 'S1', max: 100, current: 50, coverageH: 8, thresholds: { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 } }])
    expect(green).toContain('bg-ok-bg')
    const red = run([{ sku: 'S1', max: 100, current: 50, coverageH: 0.5, thresholds: { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 } }])
    expect(red).toContain('bg-bad-bg')
    const yellow = run([{ sku: 'S1', max: 100, current: 50, coverageH: 2.5, thresholds: { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 } }])
    expect(yellow).toContain('bg-warn-bg')
  })
})
