import { Step, StepLabel, Stepper } from '@mui/material'
import type { ReactElement } from 'react'
import type { UiSnapshot } from './bridge'

const STEPS = ['放置水源', '调节参数', '观察水面']

export function GuideCluster({ snapshot }: { snapshot: UiSnapshot }): ReactElement {
  const placed = snapshot.state.sources.length > 0
  const activeStep = snapshot.placing || !placed ? 0 : snapshot.state.sim.paused ? 1 : 2
  return (
    <Stepper activeStep={activeStep} orientation="vertical">
      {STEPS.map((label) => (
        <Step key={label}>
          <StepLabel>{label}</StepLabel>
        </Step>
      ))}
    </Stepper>
  )
}
