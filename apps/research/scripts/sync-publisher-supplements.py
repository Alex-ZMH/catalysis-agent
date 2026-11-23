"""Cache unedited text from public Figshare PDF supplements linked to a bibliographic query."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlencode

def fetch(url, limit):
    return subprocess.check_output(['curl','-qfsSL','--retry','1','--max-time','25','--max-filesize',str(limit),'--',url],stderr=subprocess.DEVNULL)

def api(url):
    return json.loads(fetch(url, 12*1024*1024))

def cache_article(doi):
    records=[]
    try:
        items=api('https://api.figshare.com/v2/articles?'+urlencode({'resource_doi':doi,'page_size':30}))
        for item in items:
            if str(item.get('resource_doi','')).lower()!=doi:
                continue
            article=api('https://api.figshare.com/v2/articles/'+str(int(item['id'])))
            for file in article.get('files',[]):
                if not file['name'].lower().endswith('.pdf') or not 0<file['size']<=12*1024*1024:
                    continue
                link='https://ndownloader.figshare.com/files/'+str(int(file['id']))
                with tempfile.TemporaryDirectory() as temp:
                    pdf=Path(temp)/'article.pdf'
                    data=fetch(link,12*1024*1024)
                    if len(data)!=file['size'] or not data.startswith(b'%PDF-'):
                        continue
                    digest=hashlib.md5(data).hexdigest()
                    if file.get('computed_md5') and digest!=file['computed_md5'].lower():
                        continue
                    pdf.write_bytes(data)
                    out=subprocess.check_output(['pdftotext','-enc','UTF-8',str(pdf),'-'],timeout=30)
                pages=out.decode('utf-8').split('\f')
                records.append({'doi':article['doi'],'url':link,'filename':file['name'],'sha256':hashlib.sha256(data).hexdigest(),'pages':pages})
    except (subprocess.SubprocessError,ValueError,KeyError) as error:
        print(doi,'unavailable',type(error).__name__,flush=True)
    if records:
        dest=args.output/(hashlib.sha256(doi.encode()).hexdigest()+'.json')
        with tempfile.NamedTemporaryFile(mode='w',dir=args.output,delete=False,encoding='utf8') as out:
            json.dump({'paper':doi,'files':records},out,ensure_ascii=False)
        Path(out.name).replace(dest)
        print(doi,'cached',len(records),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--query',required=True)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'standalone'/'publisher-library')
    args=parser.parse_args()
    args.output.mkdir(exist_ok=True,parents=True)
    params={'format':'json','pageSize':100,'query':args.query,'cursorMark':'*'}
    dois=set()
    while True:
        d=api('https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+urlencode(params))
        items=d['resultList']['result']
        dois.update(x['doi'].lower() for x in items if x.get('doi'))
        nxt=d.get('nextCursorMark')
        if not nxt or nxt==params['cursorMark'] or len(items)<100:break
        params['cursorMark']=nxt
    print('candidate publications',len(dois),flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(cache_article,sorted(dois)))
