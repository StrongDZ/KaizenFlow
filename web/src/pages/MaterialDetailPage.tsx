import { useParams } from 'react-router-dom'
import { MaterialDetail } from '../components/detail/MaterialDetail'

export default function MaterialDetailPage() {
  return <MaterialDetail code={useParams().code ?? ''} variant="page" />
}
