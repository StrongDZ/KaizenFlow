import { useParams } from 'react-router-dom'
import { NodeTypeDetail } from '../components/detail/NodeTypeDetail'

export default function NodeTypeDetailPage() {
  return <NodeTypeDetail code={useParams().code ?? ''} variant="page" />
}
