/**
 * seed-locations.js
 * Seeds all Fooda locations into Firestore
 * Run: node seed-locations.js
 */

import { initializeApp } from 'firebase/app'
import { getFirestore, doc, setDoc } from 'firebase/firestore'
import { readFileSync } from 'fs'

// ── Paste your Firebase config here ──────────────────────────
const firebaseConfig = {
  apiKey:            AIzaSyBWn6zVdd6E4yQrYMr1NN1a8tMBDWdpZbA
  authDomain:        'the-grove-70180.firebaseapp.com',
  projectId:         'the-grove-70180',
  storageBucket:     'the-grove-70180.appspot.com',
  messagingSenderId: 155052393852
  appId:             1:155052393852:web:f53ce053d1d814944910f9
}

const app = initializeApp(firebaseConfig)
const db  = getFirestore(app)

// ── Location data from Regions.xlsx ──────────────────────────
const LOCATIONS = {
  // Alex Oetkin's Region
  'CR_30IA':                          { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_BCH Needham':                   { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_Best Buy':                      { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_EIP Cafe':                      { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_Elevance Health':               { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_Elevance Health Atlanta':       { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_Elevance Health Corporate HQ':  { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_Georgia Power':                 { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_NetApp':                        { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_Netpark Tampa':                 { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_NorthPark':                     { director: 'Alex Oetkin',        region: 'Alex' },
  'CR_TMC':                           { director: 'Alex Oetkin',        region: 'Alex' },
  'SO_Workplace Convenience Services':{ director: 'Alex Oetkin',        region: 'Alex' },

  // Jen Trost's Region
  'CR_800 Brand':                     { director: 'Jen Trost',          region: 'Jen' },
  'CR_Lumen Denver':                  { director: 'Jen Trost',          region: 'Jen' },
  'CR_So CA Gas':                     { director: 'Jen Trost',          region: 'Jen' },
  'CR_ULA':                           { director: 'Jen Trost',          region: 'Jen' },
  'CR_Vans OC':                       { director: 'Jen Trost',          region: 'Jen' },
  'CR_VF Corporation':                { director: 'Jen Trost',          region: 'Jen' },
  'CR_VF Greensboro':                 { director: 'Jen Trost',          region: 'Jen' },
  'CR_Wesley Medical KS':             { director: 'Jen Trost',          region: 'Jen' },

  // Krys Russo's Region
  'CR_200 Wood':                      { director: 'Krys Russo',         region: 'Krys' },
  'CR_330 Kilbourn':                  { director: 'Krys Russo',         region: 'Krys' },
  'CR_330 N Wabash Chicago':          { director: 'Krys Russo',         region: 'Krys' },
  'CR_1540Broadway':                  { director: 'Krys Russo',         region: 'Krys' },
  'CR_CCC':                           { director: 'Krys Russo',         region: 'Krys' },
  'CR_Discover Riverwoods':           { director: 'Krys Russo',         region: 'Krys' },
  'CR_Discover Whitehall':            { director: 'Krys Russo',         region: 'Krys' },
  'CR_FMI':                           { director: 'Krys Russo',         region: 'Krys' },
  'CR_Paramount NYC':                 { director: 'Krys Russo',         region: 'Krys' },
  'CR_Royal Philips Cambridge':       { director: 'Krys Russo',         region: 'Krys' },
  'CR_Switching Stations':            { director: 'Krys Russo',         region: 'Krys' },
  'CR_Times Square Tower':            { director: 'Krys Russo',         region: 'Krys' },
  'CR_Triangle Plaza':                { director: 'Krys Russo',         region: 'Krys' },
  'CR_Vantive HQ':                    { director: 'Krys Russo',         region: 'Krys' },
  'Northern Trust':                   { director: 'Krys Russo',         region: 'Krys' },
  'Rush':                             { director: 'Krys Russo',         region: 'Krys' },

  // Paul Baerenstecher's Region
  'CR_1200 Enclave':                  { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_7700 Parmer':                   { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Broadmoor':                     { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_CityWest':                      { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Credit Human':                  { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Exxon Baytown':                 { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Four Oaks Place':               { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Marathon Oil':                  { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Medical City Dallas':           { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Oncor':                         { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Phillips 66':                   { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Plaza at Enclave':              { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Sally Beauty':                  { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Southwest Airlines':            { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_TBK Bank':                      { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_TMobile':                       { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Trive':                         { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_Weatherford':                   { director: 'Paul Baerenstecher', region: 'Paul' },
  'CR_West Memorial':                 { director: 'Paul Baerenstecher', region: 'Paul' },

  // Troy Robinson's Region
  'CR_Berkeley Cafeteria':            { director: 'Troy Robinson',      region: 'Troy' },
  'CR_JPMC':                          { director: 'Troy Robinson',      region: 'Troy' },
  "CR_Levi's":                        { director: 'Troy Robinson',      region: 'Troy' },
  'CR_QualcommBoulder':               { director: 'Troy Robinson',      region: 'Troy' },
  'CR_QualcommSanDiego':              { director: 'Troy Robinson',      region: 'Troy' },
  'CR_QualcommSantaClara':            { director: 'Troy Robinson',      region: 'Troy' },
}

const TENANT_ID = 'fooda'

async function seed() {
  console.log(`Seeding ${Object.keys(LOCATIONS).length} locations to Firestore...`)

  // 1. Write to legacy inv_locs key (used by location dropdown)
  const legacyRef = doc(db, 'tenants', TENANT_ID, 'legacy', 'inv_locs')
  const legacyData = {}
  Object.entries(LOCATIONS).forEach(([name, meta]) => {
    legacyData[name] = {
      name,
      director: meta.director,
      region:   meta.region,
      active:   true,
      createdAt: new Date().toISOString(),
    }
  })
  await setDoc(legacyRef, { value: legacyData, updatedAt: new Date().toISOString() }, { merge: true })
  console.log('✅ Legacy inv_locs written')

  // 2. Write each location as its own Firestore document
  for (const [name, meta] of Object.entries(LOCATIONS)) {
    const safeId = name.replace(/[^a-zA-Z0-9]/g, '_')
    const locRef = doc(db, 'tenants', TENANT_ID, 'locations', safeId)
    await setDoc(locRef, {
      name,
      director:  meta.director,
      region:    meta.region,
      active:    true,
      tenantId:  TENANT_ID,
      createdAt: new Date().toISOString(),
    }, { merge: true })
    console.log(`  ✓ ${name}`)
  }

  console.log(`\n✅ Done! ${Object.keys(LOCATIONS).length} locations seeded.`)
  process.exit(0)
}

seed().catch(err => {
  console.error('❌ Seed failed:', err)
  process.exit(1)
})
