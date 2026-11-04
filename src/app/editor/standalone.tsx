import { createRoot } from 'react-dom/client';
import { EditorApp } from './EditorApp';
const root = document.getElementById('root');
if (root) createRoot(root).render(<EditorApp />);
