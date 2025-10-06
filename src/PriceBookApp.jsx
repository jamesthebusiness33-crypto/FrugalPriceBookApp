import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, orderBy, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';

// --- Global Firebase Configuration (Optional Setup) ---
// Check if Firebase config is provided via global variables (for Netlify deployment)
const appId = (typeof window !== 'undefined' && window.__app_id) ? window.__app_id : 'demo-app';
const firebaseConfig = (typeof window !== 'undefined' && window.__firebase_config) 
  ? JSON.parse(window.__firebase_config) 
  : {};
const initialAuthToken = (typeof window !== 'undefined' && window.__initial_auth_token) 
  ? window.__initial_auth_token 
  : null;

// Initialize Firebase services only if config is provided
const app = Object.keys(firebaseConfig).length > 0 ? initializeApp(firebaseConfig) : null;
const db = app ? getFirestore(app) : null;
const auth = app ? getAuth(app) : null;

const PriceBookApp = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userId, setUserId] = useState(null);
  const [uniqueItems, setUniqueItems] = useState([]); 
  const [selectedItem, setSelectedItem] = useState(''); 

  const [form, setForm] = useState({
    name: '',
    price: '',
    quantity: '',
    unit: 'oz',
    rockBottomPrice: '',
    store: '',
  });

  // Check if Firebase is configured
  const isFirebaseConfigured = app && db && auth;

  // --- Auth & Firestore Setup ---
  useEffect(() => {
    if (!isFirebaseConfigured) {
      // Demo mode - use local storage and simulate authentication
      setIsAuthenticated(true);
      setUserId('demo-user');
      setLoading(false);
      
      // Load items from localStorage
      const savedItems = localStorage.getItem('frugal-price-book-items');
      if (savedItems) {
        try {
          const parsedItems = JSON.parse(savedItems);
          setItems(parsedItems);
          
          // Calculate unique items
          const uniqueNames = [...new Set(parsedItems.map(item => item.name))].sort();
          setUniqueItems(uniqueNames);
        } catch (error) {
          console.error('Error parsing saved items:', error);
        }
      }
      return;
    }

    const setupAuth = async () => {
      try {
        // Sign in using the provided token if available, otherwise sign in anonymously
        if (initialAuthToken) {
          await signInWithCustomToken(auth, initialAuthToken);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Firebase Auth Error:", error);
      }
    };

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setIsAuthenticated(true);
        setUserId(user.uid);
      } else {
        setIsAuthenticated(false);
        setUserId(null); 
      }
      setLoading(false);
    });

    setupAuth();
    return () => unsubscribe();
  }, [isFirebaseConfigured]);

  // --- Real-time Data Fetching ---
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    
    // Skip Firestore setup if not configured (already loaded from localStorage in auth effect)
    if (!isFirebaseConfigured) return;

    // Firestore Path: /artifacts/{appId}/users/{userId}/price_book
    const priceBookPath = `artifacts/${appId}/users/${userId}/price_book`;
    const q = query(collection(db, priceBookPath), orderBy('timestamp', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedItems = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        // Ensure price fields are numeric for calculations
        price: Number(doc.data().price),
        quantity: Number(doc.data().quantity),
        rockBottomPrice: Number(doc.data().rockBottomPrice),
        unitPrice: Number(doc.data().unitPrice)
      }));
      setItems(fetchedItems);
      
      // Calculate unique items for the dropdown selector
      const uniqueNames = [...new Set(fetchedItems.map(item => item.name))].sort();
      setUniqueItems(uniqueNames);
    }, (error) => {
      console.error("Firestore Snapshot Error:", error);
    });

    return () => unsubscribe();
  }, [isAuthenticated, userId, isFirebaseConfigured]);

  // --- Historical Low Price Calculation ---
  const historicalLowPrice = useMemo(() => {
    if (!selectedItem) return 0;
    
    const relevantItems = items.filter(item => item.name === selectedItem);
    if (relevantItems.length === 0) return 0;

    const lowestPrice = relevantItems.reduce((min, item) => 
      Math.min(min, item.unitPrice), Infinity
    );

    return lowestPrice === Infinity ? 0 : lowestPrice;
  }, [selectedItem, items]);

  // --- Item Selection Handler ---
  const handleItemSelect = (e) => {
    const name = e.target.value;
    setSelectedItem(name);

    if (name) {
        const lastEntry = items.find(item => item.name === name);
        if (lastEntry) {
            setForm(prev => ({
                ...prev,
                name: lastEntry.name,
                unit: lastEntry.unit || 'oz', 
                // Only use historical price if a valid historical price exists
                rockBottomPrice: historicalLowPrice > 0 ? historicalLowPrice.toFixed(4) : (lastEntry.rockBottomPrice ? lastEntry.rockBottomPrice.toFixed(4) : ''), 
            }));
        }
    } else {
        // Reset form for new manual entry
        setForm({ name: '', price: '', quantity: '', unit: 'oz', rockBottomPrice: '', store: '' });
    }
  };

  // --- Unit Price Calculation ---
  const calculateUnitPrice = (price, quantity) => {
    if (price <= 0 || quantity <= 0) return 0;
    // Round to 5 decimal places to maintain precision for small unit prices
    return parseFloat((price / quantity).toFixed(5)); 
  };

  const handleFormChange = (e) => {
    const { name, value } = e.target;
    // If typing manually, update the selected item name
    if (name === 'name') {
      setSelectedItem(value);
    }
    setForm(prev => ({ ...prev, [name]: value }));
  };

  // Memoized unit price calculation for real-time form feedback
  const currentUnitPrice = useMemo(() => {
    const price = parseFloat(form.price);
    const quantity = parseFloat(form.quantity);
    return calculateUnitPrice(price, quantity);
  }, [form.price, form.quantity]);


  // --- Item Submission ---
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!isAuthenticated) {
      console.error("App not authenticated.");
      return;
    }

    const priceNum = parseFloat(form.price);
    const quantityNum = parseFloat(form.quantity);
    // Parse rockBottomPrice from string, default to 0 if empty
    let rockBottomNum = parseFloat(form.rockBottomPrice) || 0; 

    if (!form.name || priceNum <= 0 || quantityNum <= 0) {
      alert("Validation Error: Please fill out Item Name, Price, and Quantity with positive numbers.");
      return;
    }

    const unitPriceCalculated = calculateUnitPrice(priceNum, quantityNum);

    // Update Rock Bottom Price logic: if the current purchase is lower than the historical low, update the rock bottom target
    if (historicalLowPrice > 0) {
        rockBottomNum = Math.min(rockBottomNum, historicalLowPrice, unitPriceCalculated);
    } else if (rockBottomNum === 0) {
        // If no historical low and no target set, the current price is the initial rock bottom
        rockBottomNum = unitPriceCalculated;
    }

    const newItem = {
      id: Date.now().toString(), // Simple ID for demo mode
      name: form.name.trim(),
      price: priceNum,
      quantity: quantityNum,
      unit: form.unit,
      store: form.store.trim() || 'Unknown',
      rockBottomPrice: rockBottomNum,
      unitPrice: unitPriceCalculated,
      timestamp: new Date().toISOString(),
    };

    try {
      if (isFirebaseConfigured) {
        // Use Firestore
        const priceBookPath = `artifacts/${appId}/users/${userId}/price_book`;
        await addDoc(collection(db, priceBookPath), {
          ...newItem,
          timestamp: serverTimestamp()
        });
      } else {
        // Use local storage
        const updatedItems = [newItem, ...items];
        setItems(updatedItems);
        localStorage.setItem('frugal-price-book-items', JSON.stringify(updatedItems));
        
        // Update unique items
        const uniqueNames = [...new Set(updatedItems.map(item => item.name))].sort();
        setUniqueItems(uniqueNames);
      }
      
      // Clear form after successful submission
      setForm({ name: '', price: '', quantity: '', unit: 'oz', rockBottomPrice: '', store: '' });
      setSelectedItem('');
    } catch (error) {
      console.error("Error adding item:", error);
    }
  };

  // --- Render Functions ---
  const renderDealStatus = (item) => {
    if (item.rockBottomPrice === 0) {
      return <span className="text-gray-500">No Target Set</span>;
    }
    
    // Check if the current entry price is the rock bottom (or lower than previous rock bottom)
    const isRockBottom = item.unitPrice <= historicalLowPrice || (historicalLowPrice === 0 && item.unitPrice === item.rockBottomPrice);
    const isGoodDeal = item.unitPrice <= item.rockBottomPrice;
    
    // Check if price is within 10% of target
    const isCloseDeal = item.unitPrice > item.rockBottomPrice && item.unitPrice <= item.rockBottomPrice * 1.1;

    if (isRockBottom) {
       return <span className="font-semibold text-purple-600">New Rock Bottom Price!</span>;
    } else if (isGoodDeal) {
      return <span className="font-semibold text-green-600">Good Deal!</span>;
    } else if (isCloseDeal) {
      return <span className="font-semibold text-yellow-600">Close Deal</span>;
    } else {
      return <span className="font-semibold text-red-600">Bad Deal</span>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="flex flex-col items-center p-8">
            <svg className="animate-spin h-8 w-8 text-green-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="mt-3 text-xl text-gray-700">Loading Frugal Price Book securely...</p>
        </div>
      </div>
    );
  }

  // Helper to format unit price clearly
  const formatUnitPrice = (price) => {
    // Show 5 decimal places for precision on very small unit prices
    return `$${price.toFixed(5)}`; 
  };
  
  // Helper to format currency
  const formatCurrency = (amount) => {
    return `$${Number(amount).toFixed(2)}`;
  };
  
  return (
    <div className="min-h-screen bg-gray-50 font-sans p-4 sm:p-8">
      <div className="max-w-5xl mx-auto">
        
        <header className="py-6 border-b border-gray-200 mb-6 flex justify-between items-center">
          <div>
            <h1 className="text-4xl font-extrabold text-green-700 tracking-tight">
              Digital Price Book 📊
            </h1>
            <p className="mt-2 text-gray-500 text-lg">
              Automate the math and track your personal "Rock Bottom Price."
            </p>
            {!isFirebaseConfigured && (
              <div className="mt-2 px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium inline-block">
                Demo Mode - Data stored locally in your browser
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-400">
              User ID: {userId}
            </div>
            <div className="text-sm font-medium text-green-600">
              {items.length} Entries Logged
            </div>
          </div>
        </header>

        {/* --- Input Form --- */}
        <section className="bg-white p-6 rounded-xl shadow-2xl mb-8 border border-green-100">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">Log a New Purchase</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            
            {/* --- Existing Item Selector --- */}
            {uniqueItems.length > 0 && (
                <div className="mb-4">
                    <label htmlFor="itemSelector" className="block text-sm font-medium text-gray-700 mb-1">
                        Select Item to Track (or type a new one below):
                    </label>
                    <select
                        id="itemSelector"
                        value={selectedItem}
                        onChange={handleItemSelect}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150 bg-white"
                    >
                        <option value="">-- Choose from History --</option>
                        {uniqueItems.map((name, index) => (
                            <option key={index} value={name}>{name}</option>
                        ))}
                    </select>
                </div>
            )}

            <input
              type="text"
              name="name"
              value={form.name}
              onChange={handleFormChange}
              placeholder="Item Name (e.g., Black Beans, Coffee, Detergent)"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150"
              required
            />
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <input
                type="number"
                name="price"
                value={form.price}
                onChange={handleFormChange}
                placeholder="Price Paid ($)"
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150"
                step="0.01"
                required
              />
              <input
                type="number"
                name="quantity"
                value={form.quantity}
                onChange={handleFormChange}
                placeholder="Quantity (e.g., 12 oz, 5 lbs)"
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150"
                step="0.01"
                required
              />
              <select
                name="unit"
                value={form.unit}
                onChange={handleFormChange}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150 bg-white"
              >
                <option value="oz">Ounces (oz)</option>
                <option value="lb">Pounds (lb)</option>
                <option value="ea">Each (ea)</option>
                <option value="g">Grams (g)</option>
                <option value="ml">Milliliters (ml)</option>
              </select>
              <input
                type="text"
                name="store"
                value={form.store}
                onChange={handleFormChange}
                placeholder="Store Name (e.g., Walmart, Regional Grocer)"
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150"
              />
            </div>

            {/* --- Unit Price Display and Rock Bottom Target --- */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-green-50 p-4 rounded-xl border border-green-200">
                <div className="col-span-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Calculated Unit Price:</label>
                    <div className="text-2xl font-bold text-green-700">
                        {formatUnitPrice(currentUnitPrice)} / {form.unit}
                    </div>
                </div>
                <div className="col-span-2">
                    <label htmlFor="rockBottomPrice" className="block text-sm font-medium text-gray-700 mb-1 flex items-center">
                        Personal Rock Bottom Price (per {form.unit}):
                        {historicalLowPrice > 0 && selectedItem && (
                            <span className="ml-2 px-2 py-0.5 bg-yellow-200 text-yellow-800 rounded-full text-xs font-semibold">
                                Prev. Low: {formatUnitPrice(historicalLowPrice)}
                            </span>
                        )}
                    </label>
                    <input
                        id="rockBottomPrice"
                        type="number"
                        name="rockBottomPrice"
                        value={form.rockBottomPrice}
                        onChange={handleFormChange}
                        placeholder={`$${historicalLowPrice > 0 ? historicalLowPrice.toFixed(5) : '0.00'}`}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 transition duration-150"
                        step="0.00001"
                    />
                </div>
            </div>
            
            <button
              type="submit"
              className="w-full bg-green-600 text-white font-bold py-3 rounded-lg shadow-md hover:bg-green-700 transition duration-200 uppercase tracking-wider"
              disabled={!isAuthenticated}
            >
              Log Purchase & Track Deal
            </button>
            {!isAuthenticated && (
              <p className="text-center text-sm text-red-500">
                *Authentication required to log data.
              </p>
            )}
          </form>
        </section>

        {/* --- Price History Table --- */}
        <section className="mt-10">
          <h2 className="text-3xl font-bold text-gray-800 mb-4">Price History & Deal Tracker</h2>
          
          {items.length === 0 ? (
            <div className="text-center p-12 bg-white rounded-xl shadow-inner border border-gray-200">
              <p className="text-gray-500 text-xl">No purchases logged yet. Start tracking your deals!</p>
            </div>
          ) : (
            <div className="overflow-x-auto bg-white rounded-xl shadow-2xl border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Item / Store</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unit Price ({items[0]?.unit})</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Your Rock Bottom</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Deal Status</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50 transition duration-100">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{item.name}</div>
                        <div className="text-xs text-gray-500">{item.store}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700 font-mono">
                        {formatUnitPrice(item.unitPrice)} / {item.unit}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-mono">
                        {item.rockBottomPrice > 0 ? formatUnitPrice(item.rockBottomPrice) : 'N/A'} / {item.unit}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm">
                        {renderDealStatus(item)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default PriceBookApp;
