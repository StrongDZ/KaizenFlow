import { useParams } from 'react-router-dom'
import { ScenarioDetail } from '../components/detail/ScenarioDetail'

export default function ScenarioDetailPage() {
  return <ScenarioDetail id={Number(useParams().id)} variant="page" />
}
