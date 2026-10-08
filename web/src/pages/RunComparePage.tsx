import { useParams } from 'react-router-dom'
import { EmptyState, Loading } from '../components/ui'
import { useParentRun } from '../hooks/useParentRun'
import { useRunBundle } from '../hooks/useRunBundle'
import ComparePage from './ComparePage'

/** Tab "So với lần chạy gốc" của một lần chạy: so lần chạy này với lần chạy của scenario gốc, cùng seed. */
export default function RunComparePage() {
  const runId = Number(useParams().id)
  const { run, scenario } = useRunBundle(runId, false)
  const { run: parent, pending } = useParentRun(run.data, scenario.data)
  if (pending || !run.data) return <Loading />
  if (!parent) {
    return <EmptyState title="Lần chạy này không có lần chạy gốc">Chỉ lần chạy sinh từ một đề xuất hay một lần hiệu chỉnh mới có lần chạy gốc để so.</EmptyState>
  }
  return <ComparePage ids={[parent.id, runId]} />
}
