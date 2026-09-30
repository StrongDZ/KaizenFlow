import Form from '@rjsf/core'
import type { RJSFSchema } from '@rjsf/utils'
import validator from '@rjsf/validator-ajv8'
import { useEffect, useMemo, useRef } from 'react'
import type { Json } from '../../api/types'
import { rjsfFields, rjsfTemplates } from '../rjsfTemplates'
import { formSchema } from '../../lib/nodeTypeView'
import { labelSchema } from '../../lib/paramLabels'

const uiSchema = { 'ui:submitButtonOptions': { norender: true } }

/**
 * Form tham số mặc định của node type. rjsf tự điền giá trị rỗng vào mọi khoá và gọi onChange ngay lúc mount;
 * nếu nhận hết thì bản sao mang thêm recipes/signals rác. Nên: bỏ `required` cấp cao nhất (giống server),
 * không điền mảng theo minItems, và chỉ báo thay đổi do người dùng gây ra.
 */
export function ParamForm({ schema, value, onChange }: { schema: Json; value: Json; onChange: (v: Json) => void }) {
  const ready = useRef(false)
  const labelled = useMemo(() => labelSchema(formSchema(schema)) as RJSFSchema, [schema])
  useEffect(() => { ready.current = true }, [])
  return (
    <Form
      schema={labelled}
      formData={value}
      validator={validator}
      noValidate
      uiSchema={uiSchema}
      templates={rjsfTemplates}
      fields={rjsfFields}
      formContext={{ emptyLabel: 'Không đặt' }}
      experimental_defaultFormStateBehavior={{ arrayMinItems: { populate: 'requiredOnly' }, emptyObjectFields: 'skipDefaults' }}
      onChange={(e) => { if (ready.current) onChange((e.formData ?? {}) as Json) }}
    />
  )
}
