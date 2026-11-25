import { createTheme } from '@mui/material/styles'

/** 只保留 MUI 默认设计语言；按钮、边框、阴影等全部使用库默认值。 */
export const reservoirTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#7fe3ff' },
    secondary: { main: '#ffb168' }
  },
  typography: {
    fontFamily: "'Manrope', system-ui, sans-serif",
    button: { textTransform: 'none' }
  }
})
