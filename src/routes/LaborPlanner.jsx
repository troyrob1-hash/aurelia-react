import { useState, useMemo } from 'react'
import { useToast } from '@/components/ui/Toast'
import { Upload, Download } from 'lucide-react'
import styles from './LaborPlanner.module.css'

const GL_MAP = {
  '50410': { label:'Onsite Labor (Fooda)',       section:'Location Costs' },
  '50411': { label:'401k',                        section:'Location Costs' },
  '50412': { label:'Benefits',                    section:'Location Costs' },
  '50413': { label:'Payroll Taxes',               section:'Location Costs' },
  '50414': { label:'Bonus',                       section:'Location Costs' },
  '50420': { label:'3rd Party Labor',             section:'Location Costs' },
  '68011': { label:'Contractors (1099)',           section:'Comp & Benefits' },
  '68014': { label:'Payroll Processing',           section:'Comp & Benefits' },
  '68015': { label:'Workers Comp',                 section:'Comp & Benefits' },
  '68016': { label:'Salary Expense',               section:'Comp & Benefits' },
  '68017': { label:'Labor Subsidy',                section:'Comp & Benefits' },
  '68018': { label:'Payroll Tax',                  section:'Comp & Benefits' },
  '68019': { label:'Retirement',                   section:'Comp & Benefits' },
  '68020': { label:'Benefits Expense',             section:'Comp & Benefits' },
  '68021': { label:'Bonus Expense',                section:'Comp & Benefits' },
  '68022': { label:'Delivery Bonus',               section:'Comp & Benefits' },
  '68023': { label:'Employee Tax Credit',          section:'Comp & Benefits' },
  '68024': { label:'Severance',                    section:'Comp & Benefits' },
}

export default function LaborPlanner() {
  const toast = useToast()
  const [rows, setRows]   = useState([])
  const [source, setSource] = useState('')

  async function handleImport(e) {
    const file = e.target.files[0]
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const ab   = await file.arrayBuffer()
      const wb   = XLSX.read(new Uint8Array(ab), { type:'array' })
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { raw:false })
      const parsed = []
      data.forEach(row => {
        const glRaw = String(row['GL Code']||row['GL']||row['Account']||row['gl_code']||'').trim()
        const gl = Object.keys(GL_MAP).find(k => glRaw.includes(k))
        const amount = parseFloat(row['Amount']||row['amount']||row['Value']||row['value']||0)
        const desc = row['Description']||row['description']||row['Desc']||GL_MAP[gl]?.label||glRaw
        if (glRaw || amount) parsed.push({ gl: gl||glRaw, label: desc, amount, section: GL_MAP[gl]?.section||'Other' })
      })
      setRows(parsed)
      setSource(file.name)
      toast.success(`Imported ${parsed.length} GL lines from ${file.name}`)
    } catch(err) {
      toast.error('Import failed. Please check the file format.')
    }
    e.target.value = ''
  }

  function exportCSV() {
    const csv = [['GL Code','Description','Section','Amount'],
      ...rows.map(r=>[r.gl,r.label,r.section,r.amount.toFixed(2)])]
      .map(r=>r.map(v=>`"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv],{type:'text/csv'})
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'),{href:url,download:'labor-report.csv'}).click()
    URL.revokeObjectURL(url)
  }

  const sections = useMemo(() => {
    const s = {}
    rows.forEach(r => {
      if (!s[r.section]) s[r.section] = []
      s[r.section].push(r)
    })
    return s
  }, [rows])

  const totalOnsite = rows.filter(r=>r.gl?.startsWith('504')).reduce((s,r)=>s+r.amount,0)
  const total3rd    = rows.find(r=>r.gl==='50420')?.amount||0
  const totalComp   = rows.filter(r=>r.gl?.startsWith('68')).reduce((s,r)=>s+r.amount,0)
  const grandTotal  = rows.reduce((s,r)=>s+r.amount,0)

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Labor Costs</h1>
          <p className={styles.subtitle}>{source ? `Imported: ${source}` : 'No data loaded · Import a GL labor report to get started'}</p>
        </div>
        <div className={styles.actions}>
          {rows.length > 0 && <button className={styles.btnIcon} onClick={exportCSV}><Download size={15}/></button>}
          <label className={styles.btnImport}>
            <Upload size={14}/> Import Labor Report
            <input type="file" accept=".csv,.xlsx,.xls" style={{display:'none'}} onChange={handleImport}/>
          </label>
          {rows.length > 0 && <button className={styles.btnClear} onClick={()=>{setRows([]);setSource('')}}>Clear</button>}
        </div>
      </div>

      <div className={styles.kpiBar}>
        <div className={styles.kpi}><div className={styles.kpiL}>Total Comp & Benefits</div><div className={styles.kpiV} style={{color:'#dc2626'}}>${grandTotal.toLocaleString('en-US',{minimumFractionDigits:2})}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>Onsite Labor (Fooda)</div><div className={styles.kpiV}>${totalOnsite.toLocaleString('en-US',{minimumFractionDigits:2})}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>3rd Party Labor</div><div className={styles.kpiV}>${total3rd.toLocaleString('en-US',{minimumFractionDigits:2})}</div></div>
        <div className={styles.kpi}><div className={styles.kpiL}>GL Lines Imported</div><div className={styles.kpiV} style={{color:'#7c3aed'}}>{rows.length}</div></div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <div style={{fontSize:48}}>👷</div>
          <p className={styles.emptyTitle}>No labor data loaded</p>
          <p className={styles.emptySub}>Import a GL-coded labor report (e.g. California_Labor.xlsx) to see the full breakdown by GL code and P&L section.</p>
          <label className={styles.btnImportLg}>
            <Upload size={16}/> Import Labor Report
            <input type="file" accept=".csv,.xlsx,.xls" style={{display:'none'}} onChange={handleImport}/>
          </label>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          {Object.entries(sections).map(([section, sRows]) => (
            <div key={section}>
              <div className={styles.sectionHeader}>{section}</div>
              <table className={styles.table}>
                <thead><tr>
                  <th>GL Code</th><th>Description</th><th>P&L Section</th><th style={{textAlign:'right'}}>Amount</th>
                </tr></thead>
                <tbody>
                  {sRows.map((r,i) => (
                    <tr key={i}>
                      <td style={{fontFamily:'monospace',color:'#7c3aed'}}>{r.gl||'—'}</td>
                      <td style={{fontWeight:500}}>{r.label}</td>
                      <td style={{color:'#999'}}>{r.section}</td>
                      <td style={{textAlign:'right',fontWeight:700,color:r.amount<0?'#059669':'#dc2626'}}>
                        {r.amount<0?`(${Math.abs(r.amount).toFixed(2)})`:r.amount.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr className={styles.sectionTotal}>
                    <td colSpan={3} style={{textAlign:'right',fontWeight:700}}>Section Total</td>
                    <td style={{textAlign:'right',fontWeight:800}}>${sRows.reduce((s,r)=>s+r.amount,0).toLocaleString('en-US',{minimumFractionDigits:2})}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <div className={styles.grandTotal}>
            <span>TOTAL COMP & BENEFITS</span>
            <span>${grandTotal.toLocaleString('en-US',{minimumFractionDigits:2})}</span>
          </div>
        </div>
      )}
    </div>
  )
}
