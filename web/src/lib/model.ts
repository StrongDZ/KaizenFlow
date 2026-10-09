import type { Json, NodeType } from '../api/types'
import { DEFAULT_THRESHOLDS, type Thresholds } from './replay'

export type NodeRef = { node_type: string; params: Json }

export function byCode(list: NodeType[]): Record<string, NodeType> {
  return Object.fromEntries(list.map((t) => [t.code, t]))
}

function param<T>(node: NodeRef, types: Record<string, NodeType>, key: string): T | undefined {
  if (node.params[key] !== undefined) return node.params[key] as T
  return types[node.node_type]?.default_params[key] as T | undefined
}

export function poolKind(node: NodeRef, types: Record<string, NodeType>): string {
  return param<string>(node, types, 'kind') ?? ''
}

export function poolCount(node: NodeRef, types: Record<string, NodeType>): number {
  return param<number>(node, types, 'count') ?? 1
}

function names(list: Json[] | undefined, field: string): string[] {
  return (list ?? []).map((x) => String(x[field]))
}

export type FailureModeOption = { code: string; label: string; description: string }

/** Failure mode hiệu lực của node, kèm nội dung thân thiện cho form Scenario. */
export function failureModeOptionsOf(node: NodeRef, types: Record<string, NodeType>): FailureModeOption[] {
  const own = node.params.failure_modes as Json[] | undefined
  return (own ?? types[node.node_type]?.failure_modes ?? []).flatMap((raw) => {
    const code = typeof raw.code === 'string' ? raw.code : ''
    if (!code) return []
    return [{
      code,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : code,
      description: typeof raw.description === 'string' ? raw.description : '',
    }]
  })
}

export function failureModesOf(node: NodeRef, types: Record<string, NodeType>): string[] {
  return failureModeOptionsOf(node, types).map((mode) => mode.code)
}

export function signalsOf(node: NodeRef, types: Record<string, NodeType>): string[] {
  const own = node.params.signals as Json[] | undefined
  return names(own ?? types[node.node_type]?.signals, 'name')
}

export function thresholdsFor(node: NodeRef, types: Record<string, NodeType>): Thresholds {
  const d = types[node.node_type]?.default_params.coverage_thresholds as Partial<Thresholds> | undefined
  const o = node.params.coverage_thresholds as Partial<Thresholds> | undefined
  return { ...DEFAULT_THRESHOLDS, ...d, ...o }
}

/** Máy mặc định cho panel cảm biến: ưu tiên máy bị tiêm lỗi trong scenario. */
export function defaultSensorSubject(machines: string[], injections: Json[]): string {
  const injected = injections.map((i) => String(i.target)).find((t) => machines.includes(t))
  return injected ?? machines[0] ?? ''
}
