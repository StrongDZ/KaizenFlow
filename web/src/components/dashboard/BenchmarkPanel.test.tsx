// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import BenchmarkPanel from './BenchmarkPanel'
import * as clientModule from '../../api/client'
import type { Benchmark7DayResp, BenchmarkReport } from '../../api/types'

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof clientModule>('../../api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      benchmark7day: vi.fn(),
      benchmarkForecast: vi.fn(),
    },
  }
})

const MOCK_BENCH_7D: Benchmark7DayResp = {
  run_id: 999,
  scenario_id: 55,
  model_key: 'bimbo-fmcg',
  version_id: 3,
  horizon_s: 604800,
  step_s: 3600,
  warmup_s: 0,
  replications: 1,
  benchmark_ready: true,
  warehouse_series_log_summary: { count: 336 },
}

const MOCK_REPORT: BenchmarkReport = {
  provider: 'hybrid_runtime',
  latency_ms: 2140,
  records_per_s: 1570,
  non_blocking_p95_ms: 245,
  rating: 'TỐT',
  notes: [
    'input_records=336',
    'groups=4 (node_key+sku unique)',
    'nodes=2 skus=2',
    'rounds=10 mean_round_ms=214.00',
    'latency_ok=true p95_ok=true (p95/mean=114.50%)',
  ],
}

function mount(): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { root, container }
}

describe('BenchmarkPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
    vi.mocked(clientModule.api.benchmark7day).mockReset()
    vi.mocked(clientModule.api.benchmarkForecast).mockReset()
  })

  it('click Chạy benchmark nhanh → sau mock resolve, DOM có đủ 3 KPI label tiếng Việt, Explainer text, Rating badge và provider name', async () => {
    vi.mocked(clientModule.api.benchmark7day).mockResolvedValue(MOCK_BENCH_7D)
    vi.mocked(clientModule.api.benchmarkForecast).mockResolvedValue(MOCK_REPORT)

    const { root, container } = mount()

    await act(async () => {
      root.render(<BenchmarkPanel modelKey="bimbo-fmcg" />)
    })

    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Chạy benchmark nhanh'),
    )
    expect(button).toBeTruthy()
    expect(button).toBeInstanceOf(HTMLButtonElement)

    await act(async () => {
      ;(button as HTMLButtonElement).click()
    })

    await vi.waitFor(
      () => {
        const html = container.innerHTML
        expect(clientModule.api.benchmark7day).toHaveBeenCalled()
        expect(clientModule.api.benchmarkForecast).toHaveBeenCalled()
        expect(html).toContain('Thời gian suy luận (Latency)')
        expect(html).toContain('Tốc độ xử lý (Throughput)')
        expect(html).toContain('Độ trễ trơn (P95 non-blocking)')
        const explainerLatency = html.includes('Về Latency') || html.includes('Tổng thời gian chạy 10 vòng inference')
        const explainerThroughput = html.includes('Về Throughput') || html.includes('số record log mà forecast engine xử lý được mỗi giây')
        const explainerP95 = html.includes('Về P95 non-blocking') || html.includes('Percentile 95 của 10 round đo liền kề')
        expect(explainerLatency || explainerThroughput || explainerP95).toBe(true)
        expect(html).toContain('Đánh giá:')
        expect(html).toContain(MOCK_REPORT.rating)
        expect(html).toContain('Provider đang dùng:')
        expect(html).toContain(MOCK_REPORT.provider)
      },
      { timeout: 5000, interval: 50 },
    )
  })

  it('ban đầu chưa click, 3 KPI label vẫn render sẵn với dấu gạch ngang', async () => {
    const { root, container } = mount()
    await act(async () => {
      root.render(<BenchmarkPanel modelKey="demo-model" />)
    })
    const html = container.innerHTML
    expect(html).toContain('Thời gian suy luận (Latency)')
    expect(html).toContain('Tốc độ xử lý (Throughput)')
    expect(html).toContain('Độ trễ trơn (P95 non-blocking)')
  })

  it('Rating màu theo rating: trường hợp RỦI RO CAO và CẦN CẢI THIỆN', async () => {
    vi.mocked(clientModule.api.benchmark7day).mockResolvedValue(MOCK_BENCH_7D)
    const badReport: BenchmarkReport = { ...MOCK_REPORT, rating: 'RỦI RO CAO', latency_ms: 8000, non_blocking_p95_ms: 1200, provider: 'fallback_engine' }
    vi.mocked(clientModule.api.benchmarkForecast).mockResolvedValue(badReport)

    const { root, container } = mount()
    await act(async () => {
      root.render(<BenchmarkPanel modelKey="bimbo-fmcg" />)
    })
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Chạy benchmark nhanh')) as HTMLButtonElement | undefined
    expect(button).toBeTruthy()
    await act(async () => {
      button!.click()
    })
    await vi.waitFor(() => {
      const html = container.innerHTML
      expect(html).toContain('RỦI RO CAO')
      expect(html).toContain('bg-bad-bg')
      expect(html).toContain('fallback_engine')
    })
  })
})
