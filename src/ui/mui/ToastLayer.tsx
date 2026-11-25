import { Alert, Snackbar } from '@mui/material'
import type { ReactElement } from 'react'
import { useToasts } from './bridge'

export function ToastLayer(): ReactElement {
  const toasts = useToasts()
  const current = toasts[0]
  return (
    <Snackbar open={Boolean(current)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert severity="info" variant="outlined" sx={{ backdropFilter: 'blur(14px)' }}>
        {current?.message}
      </Alert>
    </Snackbar>
  )
}
