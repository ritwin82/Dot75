import {Brand} from "../components/brand";

export default function MarketingLayout({children}:{children:React.ReactNode}){
  return <div className="marketing-app">
    <header className="marketing-header page-width">
      <Brand theme="light"/>
      <nav className="marketing-nav" aria-label="Main navigation">
        <a href="#product">Product</a>
        <a href="#workflow">How it works</a>
        <a href="#why">Why Dot75</a>
      </nav>
      <a className="header-cta" href="/dashboard">Open dashboard</a>
    </header>
    <main>{children}</main>
    <footer className="marketing-footer page-width">
      <Brand theme="light"/>
      <p>PostgreSQL migration safety for pull requests.</p>
      <a href="/dashboard">Dashboard</a>
    </footer>
  </div>;
}
