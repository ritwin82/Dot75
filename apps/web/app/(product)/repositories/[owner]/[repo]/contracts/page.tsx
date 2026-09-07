import {ContractEditor} from "../../../../../components/contract-editor";

export default async function ContractsPage({params}:{params:Promise<{owner:string;repo:string}>}) {
  const {owner,repo}=await params;
  return <div className="contracts-page"><section className="compatibility-heading"><a className="product-link" href="/dashboard">Back to dashboard</a><div className="product-kicker">Reviewed configuration</div><h1>Contract mappings</h1><p>Map application promises to inspected PostgreSQL objects, preview the semantic change, then publish it through a normal GitHub pull request.</p></section><ContractEditor owner={owner} repo={repo}/></div>;
}
