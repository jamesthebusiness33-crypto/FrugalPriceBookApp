import React from 'react';
import ReactDOM from 'react-dom/client';
// Note: PriceBookApp.jsx must be placed in the same 'src' folder
import PriceBookApp from './PriceBookApp.jsx'; 

// Use createRoot for modern React 18 rendering
const root = ReactDOM.createRoot(document.getElementById('root'));

// Render the application
root.render(
  <React.StrictMode>
    <PriceBookApp />
  </React.StrictMode>
);
