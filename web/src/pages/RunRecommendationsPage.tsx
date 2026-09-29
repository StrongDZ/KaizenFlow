import { useMutation } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { RecommendationList } from '../components/controlroom/RecommendationList'
import { RunGate } from '../components/controlroom/RunGate'
import { Card } from '../components/ui'

function Body({ insights }: { insights: Parameters<typeof RecommendationList>[0]['insights'] }) {
  const navigate = useNavigate()
  const apply = useMutation({
    mutationFn: ({ id, rank }: { id: number; rank: number }) => api.applyInsight(id, rank),
    onSuccess: (r) => navigate(`/runs/${r.run_id}`),
  })
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card title="Đề xuất đã kiểm chứng bằng mô phỏng">
        <RecommendationList insights={insights} pending={apply.isPending} error={apply.error} onApply={(id, rank) => apply.mutate({ id, rank })} />
      </Card>
    </div>
  )
}

export default function RunRecommendationsPage() {
  const runId = Number(useParams().id)
  return <RunGate runId={runId}>{({ run }) => <Body insights={run.insights.filter((i) => i.kind === 'RECOMMENDATION')} />}</RunGate>
}
