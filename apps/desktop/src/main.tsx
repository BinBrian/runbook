import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './checklist/ChecklistApp';
import { initializeTheme } from './checklist/theme';

initializeTheme();
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
