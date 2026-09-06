import type {Metadata} from "next";
import {Bricolage_Grotesque,DM_Sans} from "next/font/google";
import "./globals.css";

const display=Bricolage_Grotesque({subsets:["latin"],variable:"--font-display",display:"swap"});
const sans=DM_Sans({subsets:["latin"],variable:"--font-sans",display:"swap"});

export const metadata:Metadata={
  title:{default:"Dot75 | PostgreSQL migration safety",template:"%s | Dot75"},
  description:"Test related PostgreSQL migrations together before they merge."
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body className={`${display.variable} ${sans.variable}`}>{children}</body></html>;
}
