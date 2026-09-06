type BrandProps={theme?:"dark"|"light"};

export function Brand({theme="dark"}:BrandProps){
  return <a className={`brand brand-${theme}`} href="/" aria-label="Dot75 home"><BrandMark/><span>Dot75</span></a>;
}

function BrandMark(){
  return <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
    <rect x="1" y="1" width="38" height="38" rx="7"/>
    <path className="brand-letter" d="M11 11v18h7.5c6 0 10.5-3.4 10.5-9s-4.5-9-10.5-9H11Z"/>
    <circle cx="17" cy="16" r="2"/>
    <circle cx="23" cy="20" r="2"/>
    <circle cx="17" cy="25" r="2"/>
    <path className="node-link" d="m18.7 17.1 2.6 1.8m0 2.2-2.6 2.5"/>
  </svg>;
}
