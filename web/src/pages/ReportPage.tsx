import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api } from '../api/client'
import { BandChart } from '../components/Charts'
import { ErrorBox, Loading, btnPrimary } from '../components/ui'
import { candidatesOf, describeAction, describeInsight, kpiP50 } from '../lib/insights'
import { byCode, thresholdsFor } from '../lib/model'
import { clip, indexBands, series } from '../lib/replay'

export default function ReportPage() {
  const runId = Number(useParams().id)
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId) })
  const scenario = useQuery({ queryKey: ['scenario', run.data?.scenario_id], queryFn: () => api.scenario(run.data!.scenario_id), enabled: !!run.data })
  const graph = useQuery({ queryKey: ['graph', scenario.data?.model_version_id], queryFn: () => api.graph(scenario.data!.model_version_id), enabled: !!scenario.data })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const bands = useQuery({ queryKey: ['bands', runId, 'coverage_h'], queryFn: () => api.bands(runId, { metric: 'coverage_h' }), enabled: run.data?.status === 'DONE' })
  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>
  if (!run.data || !scenario.data || !graph.data || !types.data || !bands.data) return <Loading />
  const r = run.data
  const typeMap = byCode(types.data)
  const idx = indexBands(bands.data)
  const risky = r.insights.filter((i) => i.kind === 'RED_RISK').map((i) => i.subject_key ?? '')
  const storages = graph.data.nodes.filter((n) => risky.includes(n.key))
  const candidates = r.insights.filter((i) => i.kind === 'RECOMMENDATION').flatMap((i) => candidatesOf(i))
  const kpi = (k: string) => kpiP50(r.kpis, k)?.toFixed(1) ?? '—'
  return (
    <div className="mx-auto max-w-4xl space-y-5 bg-white p-8 print:p-0">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Báo cáo mô phỏng &amp; dự báo logistics</h1>
          <div className="text-sm text-slate-500">
            {graph.data.model_key} v{graph.data.version} · {scenario.data.name} · Run #{r.id} · bắt đầu {new Date(r.sim_start).toLocaleString('vi-VN')}
          </div>
          <div className="text-xs text-slate-400">{scenario.data.replications} lần lặp Monte Carlo · horizon {scenario.data.horizon_s / 3600} giờ · engine {r.engine_version}</div>
        </div>
        <button className={`${btnPrimary} print:hidden`} onClick={() => window.print()}>In / Lưu PDF</button>
      </div>

      <section>
        <h2 className="mb-2 font-semibold">1. Chỉ số chính (trung vị)</h2>
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-t"><td className="py-1">Sản lượng xuất</td><td className="text-right">{kpi('throughput')}</td></tr>
            <tr className="border-t"><td className="py-1">Tổng phút Đỏ</td><td className="text-right">{kpi('red_minutes')}</td></tr>
            <tr className="border-t"><td className="py-1">Nợ đơn cuối kỳ</td><td className="text-right">{kpi('backorder_end')}</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">2. Dự báo &amp; điểm nghẽn</h2>
        <ul className="list-disc pl-5 text-sm">
          {r.insights.filter((i) => i.kind !== 'RECOMMENDATION').map((i) => <li key={i.id}>{describeInsight(i)}</li>)}
        </ul>
        {storages.map((n) => (
          <div key={n.key} className="mt-3 break-inside-avoid">
            <div className="text-sm font-medium">{n.key} — số giờ tồn kho còn đủ dùng</div>
            <BandChart points={clip(series(idx, n.key, 'coverage_h'), 24)} redH={thresholdsFor(n, typeMap).red_h} height={180} />
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">3. Hành động đề xuất (đã kiểm chứng bằng mô phỏng)</h2>
        {candidates.length === 0 && <div className="text-sm text-slate-500">Không có hành động nào cải thiện được kết quả.</div>}
        <table className="w-full text-sm">
          <tbody>
            {candidates.map((c) => (
              <tr key={c.rank} className="border-t">
                <td className="py-1">#{c.rank}</td>
                <td>{describeAction(c.action)}</td>
                <td className="text-right">−{c.delta_kpi.red_minutes.toFixed(1)} phút Đỏ</td>
                <td className="text-right">{c.delta_kpi.throughput >= 0 ? '+' : ''}{c.delta_kpi.throughput.toFixed(1)} sản lượng</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="text-xs text-slate-400">
        Tham số thiết bị là giả định (chưa có dữ liệu DENSO), đánh dấu "assumed" trong catalog. Kết quả là phân phối từ nhiều lần mô phỏng, không phải một kịch bản duy nhất.
      </section>
    </div>
  )
}
