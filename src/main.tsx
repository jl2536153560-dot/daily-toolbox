import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

// Hash routes keep shared links refreshable on GitHub Pages without server rewrites.
const Router = import.meta.env.VITE_ROUTER_MODE === 'hash' ? HashRouter : BrowserRouter;
createRoot(document.getElementById('root')!).render(<Router><App /></Router>);
