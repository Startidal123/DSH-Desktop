export const MODEL_GROUPS = [
  {
    provider: 'deepseek-official',
    label: 'DeepSeek 官方',
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        desc: '最新 Flash 模型 · 支持图像输入',
      },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        desc: '快速高效，适合日常与并行任务',
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        desc: '更强的编码与复杂推理，成本更高',
      },
      {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek-V4-Flash-Vision-Exp',
        desc: '视觉实验版 · 支持图像输入',
      },
    ],
  },
]

export function findModel(provider, modelId) {
  for (const group of MODEL_GROUPS) {
    for (const model of group.models) {
      if (group.provider === provider && model.id === modelId) return model
    }
  }
  return null
}

export function modelDisplayName(provider, modelId) {
  return findModel(provider, modelId)?.name ?? modelId ?? '未选择'
}
