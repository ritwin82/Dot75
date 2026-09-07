import type {Metadata} from "next";
import "./globals.css";

export const metadata:Metadata={
  title:{default:"Dot75 | PostgreSQL migration safety",template:"%s | Dot75"},
  description:"Test related PostgreSQL migrations together before they merge."
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body>{children}</body></html>;
}
