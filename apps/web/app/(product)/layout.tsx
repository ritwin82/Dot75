import {Brand} from "../components/brand";

export default function ProductLayout({children}:{children:React.ReactNode}){
  return <div className="product-app">
    <header className="product-header">
      <Brand theme="dark"/>
      <nav aria-label="Dashboard navigation"><a className="active" href="/dashboard">Overview</a><a href="/">About Dot75</a></nav>
    </header>
    <main className="product-main">{children}</main>
    <footer className="product-footer"><span>Dot75</span><span>Installation workspace</span></footer>
  </div>;
}
