import { useQuery } from '@tanstack/react-query'
import { gaugeConfigApi } from '../../api/gaugeConfig'
import { TYPE_LABEL } from '../../lib/gaugeDiscovery'

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Độ chính xác đo tại hiện trường: từ các mẫu nghiệm thu (giá trị người dùng thấy so với số hệ thống đọc).
    Cận dưới 95% là điều số mẫu chứng minh được: 10 mẫu đạt cả 10 mới chứng minh khoảng 72%. */
export function AccuracyPanel() {
  const q = useQuery({ queryKey: ['gauge-config', 'accuracy'], queryFn: gaugeConfigApi.accuracy, retry: false })
  const r = q.data
  return (
    <section className="rounded-lg border border-line bg-panel p-3.5">
      <h2 className="text-[13px] font-semibold text-text">Độ chính xác đo tại hiện trường</h2>
      {!r || r.samples === 0 ? (
        <p className="mt-1 text-xs text-muted">
          Chưa có mẫu nào. Mỗi lần nghiệm thu một đồng hồ (trang camera, mục 5: nhập giá trị đang thấy) là một mẫu; cần ít nhất vài chục mẫu
          mỗi loại đồng hồ thì con số mới có ý nghĩa.
        </p>
      ) : (
        <table className="mt-2 w-full text-xs">
          <thead className="text-[11px] text-muted">
            <tr><th className="text-left font-normal">Loại</th><th className="text-right font-normal">Mẫu</th><th className="text-right font-normal">Đạt</th>
              <th className="text-right font-normal" title="Cận dưới khoảng tin cậy 95%">Chắc chắn ít nhất</th><th className="text-right font-normal">Sai số kim</th></tr>
          </thead>
          <tbody>
            {r.by_type.map((t) => (
              <tr key={t.key} className="border-t border-line">
                <td className="py-1 text-text">{TYPE_LABEL[t.type] ?? t.type}</td>
                <td className="text-right tabular-nums">{t.samples}</td>
                <td className="text-right tabular-nums">{pct(t.pass_rate)}</td>
                <td className={`text-right tabular-nums ${t.lower_bound < 0.9 ? 'text-warn' : 'text-text'}`}>{pct(t.lower_bound)}</td>
                <td className="text-right tabular-nums text-muted">{t.mean_error_pct === undefined ? '—' : `${t.mean_error_pct.toFixed(1)}% thang đo`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
