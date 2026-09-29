import { useParams } from 'react-router-dom'
import { RunGate } from '../components/controlroom/RunGate'
import { SensorPanel } from '../components/controlroom/SensorPanel'

export default function RunSensorsPage() {
  const runId = Number(useParams().id)
  return (
    <RunGate runId={runId}>
      {({ run, scenario, graph, types }) => (
        <div className="mx-auto max-w-5xl p-6">
          <SensorPanel runId={run.id} graph={graph} types={types} injections={scenario.injections} height={360} />
        </div>
      )}
    </RunGate>
  )
}
