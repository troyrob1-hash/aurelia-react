// src/hooks/useVendors.js
import { useState, useEffect, useCallback } from 'react'
import { collection, query, where, orderBy, onSnapshot, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuthStore } from '@/store/authStore'

export function useVendors() {
  const { orgId } = useAuthStore()
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId) return
    const q = query(
      collection(db, 'tenants', orgId, 'vendors'),
      where('active', '==', true),
      orderBy('name')
    )import { collection, query, where, orderBy, onSnapshot, addDoc, updateDoc, doc, serverTimestamp, writeBatch } from 'firebase/firestore'
    const unsub = onSnapshot(q, snap => {
      setVendors(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return unsub
  }, [orgId])

  const addVendor = useCallback(async (data) => {
    if (!orgId) return
    return addDoc(collection(db, 'tenants', orgId, 'vendors'), {
      ...data,
      active: true,
      createdAt: serverTimestamp(),
    })
  }, [orgId])

  return { vendors, loading, addVendor }
}

// src/hooks/useProducts.js
export function useProducts(vendorId = null) {
  const { orgId } = useAuthStore()
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId) return
    let q = query(
      collection(db, 'tenants', orgId, 'products'),
      where('active', '==', true),
      orderBy('category'),
      orderBy('name')
    )
    if (vendorId) {
      q = query(
        collection(db, 'tenants', orgId, 'products'),
        where('vendorId', '==', vendorId),
        where('active', '==', true),
        orderBy('category'),
        orderBy('name')
      )
    }
    const unsub = onSnapshot(q, snap => {
      setProducts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return unsub
  }, [orgId, vendorId])

  return { products, loading }
}

// src/hooks/useInventory.js  
export function useInventory(locationId) {
  const { orgId } = useAuthStore()
  const [inventory, setInventory] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId || !locationId) return
    // Inventory keyed as locationId__productId
    const q = query(
      collection(db, 'tenants', orgId, 'inventory'),
      where('locationId', '==', locationId)
    )
    const unsub = onSnapshot(q, snap => {
      const inv = {}
      snap.docs.forEach(d => {
        const data = d.data()
        inv[data.productId] = data
      })
      setInventory(inv)
      setLoading(false)
    })
    return unsub
  }, [orgId, locationId])

  return { inventory, loading }
}

// ============================================
// SEED DATA MIGRATION SCRIPT
// Run once to populate Firestore from hardcoded data
// ============================================

export const SEED_VENDORS = [
  { id:'sysco', name:'Sysco', url:'https://shop.sysco.com', accountNum:'', terms:'Net 30', defaultGlCode:'50100', active:true },
  { id:'nassau', name:'Nassau Candy', url:'https://www.nassaucandy.com', accountNum:'', terms:'Net 30', defaultGlCode:'50100', active:true },
  { id:'vistar', name:'Vistar', url:'https://www.vistar.com', accountNum:'', terms:'Net 30', defaultGlCode:'50100', active:true },
  { id:'cafemoto', name:'Café Moto', url:'https://www.cafemoto.com', accountNum:'', terms:'Net 15', defaultGlCode:'50200', active:true },
  { id:'davidrio', name:'David Rio', url:'https://www.davidrio.com', accountNum:'', terms:'Net 30', defaultGlCode:'50200', active:true },
  { id:'amazon', name:'Amazon Business', url:'https://business.amazon.com', accountNum:'', terms:'Credit Card', defaultGlCode:'50300', active:true },
  { id:'webstaurant', name:'Webstaurant', url:'https://www.webstaurantstore.com', accountNum:'', terms:'Credit Card', defaultGlCode:'50300', active:true },
  { id:'bluecart', name:'Blue Cart', url:'https://www.bluecart.com', accountNum:'', terms:'Net 30', defaultGlCode:'50100', active:true },
  { id:'rtzn', name:'RTZN', url:'https://www.rtznbrands.com', accountNum:'', terms:'Net 30', defaultGlCode:'50100', active:true },
]

export const SEED_PRODUCTS = [
  // Sysco - Beverages
  { vendorId:'sysco', category:'Beverages', name:'Red Bull 12 oz', sku:'SYS-1234567', pack:'case/24', unitCost:1.98, par:2, glCode:'50110', active:true },
  { vendorId:'sysco', category:'Beverages', name:'Celsius tropical vibe 12 oz', sku:'SYS-5541209', pack:'case/12', unitCost:1.98, par:2, glCode:'50110', active:true },
  { vendorId:'sysco', category:'Beverages', name:'Smart Water 20 oz', sku:'SYS-8892341', pack:'case/24', unitCost:1.63, par:3, glCode:'50110', active:true },
  { vendorId:'sysco', category:'Beverages', name:'Gatorade lemon lime 20 oz', sku:'SYS-4421890', pack:'case/24', unitCost:1.04, par:2, glCode:'50110', active:true },
  { vendorId:'sysco', category:'Beverages', name:'Diet Coke', sku:'SYS-3312091', pack:'case/24', unitCost:0.84, par:1, glCode:'50110', active:true },
  // Sysco - Dairy
  { vendorId:'sysco', category:'Dairy', name:'Greek yogurt vanilla 5.3oz', sku:'SYS-7123450', pack:'cs/12', unitCost:1.14, par:1, glCode:'50120', active:true },
  { vendorId:'sysco', category:'Dairy', name:'Whole milk gallon', sku:'SYS-4412890', pack:'case/2', unitCost:4.76, par:2, glCode:'50120', active:true },
  { vendorId:'sysco', category:'Dairy', name:'2% milk gallon', sku:'SYS-4412891', pack:'case/2', unitCost:8.93, par:1, glCode:'50120', active:true },
  { vendorId:'sysco', category:'Dairy', name:'Oat milk Pacific', sku:'SYS-9921034', pack:'case/12', unitCost:2.78, par:1, glCode:'50120', active:true },
  // Sysco - Snacks
  { vendorId:'sysco', category:'Snacks', name:'M&M peanuts', sku:'SYS-2219034', pack:'case/48', unitCost:1.25, par:1, glCode:'50130', active:true },
  { vendorId:'sysco', category:'Snacks', name:'Snickers', sku:'SYS-2219035', pack:'case/48', unitCost:1.41, par:1, glCode:'50130', active:true },
  { vendorId:'sysco', category:'Snacks', name:'Haribo goldbears', sku:'SYS-8812398', pack:'case/12', unitCost:1.81, par:1, glCode:'50130', active:true },
  { vendorId:'sysco', category:'Snacks', name:'Uglies sea salt', sku:'SYS-3312108', pack:'case/24', unitCost:1.19, par:1, glCode:'50130', active:true },
  { vendorId:'sysco', category:'Snacks', name:'Clif bar blueberry almond', sku:'SYS-1109342', pack:'cs/12', unitCost:2.45, par:1, glCode:'50130', active:true },
  // Sysco - Supplies
  { vendorId:'sysco', category:'Supplies', name:'Ketchup packets', sku:'SYS-0023411', pack:'case/1000', unitCost:0.04, par:2, glCode:'50400', active:true },
  { vendorId:'sysco', category:'Supplies', name:'Mayonnaise packets', sku:'SYS-0023412', pack:'case/500', unitCost:0.13, par:1, glCode:'50400', active:true },
  // Sysco - Barista
  { vendorId:'sysco', category:'Barista', name:'Ghirardelli chocolate sauce', sku:'SYS-5512093', pack:'cs/6', unitCost:21.34, par:1, glCode:'50200', active:true },
  { vendorId:'sysco', category:'Barista', name:'Agave organic Monin', sku:'SYS-6612034', pack:'cs/6', unitCost:6.87, par:1, glCode:'50200', active:true },
  { vendorId:'sysco', category:'Barista', name:'Heavy cream', sku:'SYS-7712091', pack:'cs/12', unitCost:4.17, par:1, glCode:'50200', active:true },
  // Nassau
  { vendorId:'nassau', category:'Beverages', name:'Joe strawberry lemonade', sku:'NAS-1122334', pack:'case/12', unitCost:1.88, par:1, glCode:'50110', active:true },
  { vendorId:'nassau', category:'Snacks', name:'North fork original', sku:'NAS-2233445', pack:'case/24', unitCost:1.23, par:1, glCode:'50130', active:true },
  { vendorId:'nassau', category:'Snacks', name:'Sahale fruit and nut', sku:'NAS-3344556', pack:'case/9', unitCost:2.43, par:1, glCode:'50130', active:true },
  { vendorId:'nassau', category:'Snacks', name:'Barebell cookies caramel', sku:'NAS-4455667', pack:'cs/12', unitCost:2.84, par:1, glCode:'50130', active:true },
  // Cafe Moto
  { vendorId:'cafemoto', category:'Barista', name:'Espresso moto 5lb', sku:'CM-10001', pack:'each', unitCost:74.79, par:1, glCode:'50200', active:true },
  { vendorId:'cafemoto', category:'Barista', name:'Cafe moto brew 5lb', sku:'CM-10002', pack:'each', unitCost:73.05, par:1, glCode:'50200', active:true },
  { vendorId:'cafemoto', category:'Barista', name:'Decaf moto brew 5lb', sku:'CM-10003', pack:'each', unitCost:87.28, par:1, glCode:'50200', active:true },
  // David Rio
  { vendorId:'davidrio', category:'Barista', name:'Tiger spice chai 4lb', sku:'DR-20001', pack:'case/4', unitCost:11.75, par:1, glCode:'50200', active:true },
  { vendorId:'davidrio', category:'Barista', name:'Elephant vanilla chai 4lb', sku:'DR-20002', pack:'case/4', unitCost:11.75, par:1, glCode:'50200', active:true },
  { vendorId:'davidrio', category:'Barista', name:'Masala chai concentrate', sku:'DR-20003', pack:'case/4', unitCost:6.75, par:1, glCode:'50200', active:true },
]

// Migration function - run once from admin console
export async function seedVendorsAndProducts(orgId) {
  const batch = writeBatch(db)
  
  // Seed vendors
  for (const v of SEED_VENDORS) {
    const ref = doc(db, 'tenants', orgId, 'vendors', v.id)
    batch.set(ref, { ...v, createdAt: serverTimestamp() })
  }
  
  // Seed products
  for (const p of SEED_PRODUCTS) {
    const ref = doc(collection(db, 'tenants', orgId, 'products'))
    batch.set(ref, { ...p, createdAt: serverTimestamp() })
  }
  
  await batch.commit()
  console.log('✓ Seeded vendors and products')
}