"""Submit and collect PBE/LCAO spectra for the saved basal-plane models."""
import argparse
import csv
import fcntl
import json
import os
import tempfile
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import xml.etree.ElementTree as ET
import zipfile

CASES = ('clean', 'A', 'B', 'H2')
SPECIES = {'Mo': ('003_4MoS2', 'Mo_gga_7au_100Ry_4s2p2d1f.orb', 95.95),
           'S': ('003_4MoS2', 'S_gga_7au_100Ry_2s2p1d.orb', 32.06),
           'H': ('002_C2H6O', 'H_gga_6au_100Ry_2s1p.orb', 1.008)}
def prepare(path, model, case, library):
    path.mkdir(exist_ok=True)
    species = list(dict.fromkeys(a['element'] for a in model['atoms']))
    stru = ['ATOMIC_SPECIES']
    for e in species:
        example, orb, mass = SPECIES[e]
        pp = e + '_ONCV_PBE-1.0.upf'
        for f in [pp, orb]:
            shutil.copyfile(library / example / f, path / f)
        stru.append(f'{e} {mass} {pp}')
    rows = [' '.join(map(str, v)) for v in model['cell']]
    stru += ['', 'NUMERICAL_ORBITAL', *[SPECIES[e][1] for e in species],
             '', 'LATTICE_CONSTANT', '1.88972612462577', '', 'LATTICE_VECTORS', *rows,
             '', 'ATOMIC_POSITIONS', 'Direct']
    groups = [[a for a in model['atoms'] if a['element'] == e] for e in species]
    coords = []
    for e, group in zip(species, groups):
        stru += [e, '0', str(len(group))]
        for atom in group:
            pos = ' '.join(map(str, atom['fractional']))
            coords.append(pos)
            stru.append(pos + ' 1 1 1 mag ' + str(atom['magnetization']))
    (path / 'STRU').write_text('\n'.join(stru)+'\n')
    (path / 'POSCAR').write_text('\n'.join(['Mo trimer model '+case, '1.0', *rows,
        ' '.join(species), ' '.join(str(len(g)) for g in groups), 'Direct', *coords])+'\n')
    mesh = '1 1 1' if case == 'H2' else '5 5 1'
    (path / 'KPT').write_text('K_POINTS\n0\nGamma\n'+mesh+' 0 0 0\n')
    params = dict(suffix='pbe', calculation='scf', basis_type='lcao', dft_functional='pbe',
        ks_solver='scalapack_gvx', symmetry=0, nspin=2 if case in ('A','B') else 1,
        ecutwfc=60, scf_thr='1e-6', scf_nmax=160, mixing_type='broyden',
        mixing_beta=0.25, smearing_method='gaussian', smearing_sigma=0.01,
        nbands=4 if case=='H2' else 74, out_dos=1 if case!='H2' else 0,
        dos_edelta_ev=0.025, dos_sigma=0.10, cal_force=1)
    (path/'INPUT').write_text('INPUT_PARAMETERS\n'+''.join(f'{k} {v}\n' for k,v in params.items()))

def submit(work, models):
    env = Path(os.environ.get('CATALYSIS_ABACUS_ENV', Path.home()/'projects/mlcc/configs/abacus-mpich-env-v001.sh'))
    library = Path(os.environ.get('CATALYSIS_LCAO_LIBRARY', Path.home()/'abacus-work/official/examples/lcao-gv'))
    if not env.is_file() or not library.is_dir():
        raise ValueError('ABACUS environment or orbital library unavailable')
    with (work/'submit.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ids_file = work/'jobs.json'
        ids = json.loads(ids_file.read_text()) if ids_file.exists() else {}
        for case in CASES:
            if case in ids:
                continue
            path = work/case
            prepare(path, models[case], case, library)
            script = f"""#!/bin/bash
set -e
source {shlex.quote(str(env))}
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
mpirun -np "$SLURM_NTASKS" abacus > engine.log 2>&1
"""
            (path/'run.sh').write_text(script)
            receipt = subprocess.check_output(['sbatch','--parsable','--partition=cpu','--nodes=1',
                '--ntasks='+('1' if case=='H2' else '4'),'--cpus-per-task=1','--mem=3G',
                '--time=02:00:00','--job-name=cat-dos-'+case,'--output=slurm-%j.out','run.sh'],cwd=path,text=True)
            ids[case] = receipt.strip().split(';')[0]
            tmp = ids_file.with_suffix('.tmp')
            tmp.write_text(json.dumps(ids))
            tmp.replace(ids_file)
        post=submit_spectra(work,ids,relaxed=False)
    return {'scf_jobs':ids,'spectrum_jobs':post}

def submit_spectra(work,ids,relaxed):
    post_file=work/'spectral-jobs.json'
    post=json.loads(post_file.read_text()) if post_file.exists() else {}
    for case in ('clean','A','B'):
        if case in post:
            continue
        source=work/case
        path=work/(case+'-dos')
        path.mkdir(exist_ok=True)
        for f in [source/'STRU',*source.glob('*.upf'),*source.glob('*.orb')]:
            shutil.copyfile(f,path/f.name)
        config=(work.parent/case/'INPUT') if relaxed else source/'INPUT'
        base=config.read_text().replace('calculation scf','calculation nscf').replace('out_dos 1','out_dos 2').replace('cal_force 1','cal_force 0')
        (path/'INPUT').write_text(base+'init_chg file\nread_file_dir '+str((source/'OUT.pbe').resolve())+'/\ndos_emin_ev -9\ndos_emax_ev 4\n')
        (path/'KPT').write_text('K_POINTS\n0\nGamma\n9 9 1 0 0 0\n')
        script=(source/'run.sh').read_text()
        if relaxed:
            converged = shlex.quote(str((source/'OUT.pbe/running_relax.log').resolve()))
            geometry = shlex.quote(str((source/'OUT.pbe/STRU_ION_D').resolve()))
            script=script.replace('mpirun -np',f"grep -q 'Relaxation is converged!' {converged} || exit 4\ncp {geometry} STRU\nmpirun -np")
        (path/'run.sh').write_text(script)
        done=source/'OUT.pbe'/('running_relax.log' if relaxed else 'running_scf.log')
        ready=done.exists() and 'Finish Time' in done.read_text(errors='replace')
        dependency=[] if ready else ['--dependency=afterok:'+ids[case]]
        receipt=subprocess.check_output(['sbatch','--parsable','--partition=cpu','--ntasks=1','--cpus-per-task=1','--mem=3G','--time=00:45:00',
            '--job-name=cat-pdos-'+case,'--output=slurm-%j.out',*dependency,'run.sh'],cwd=path,text=True)
        post[case]=receipt.strip().split(';')[0]
        tmp=post_file.with_suffix('.tmp')
        tmp.write_text(json.dumps(post))
        tmp.replace(post_file)
    return post

def submit_relax(work):
    source_ids=json.loads((work/'jobs.json').read_text())
    base=work/'relax'
    base.mkdir(exist_ok=True)
    with (base/'submit.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        receipt=base/'jobs.json'
        ids=json.loads(receipt.read_text()) if receipt.exists() else {}
        for case in CASES:
            if case in ids:
                continue
            source=work/case
            if 'charge density convergence is achieved' not in (source/'OUT.pbe/running_scf.log').read_text():
                raise ValueError('Converge the initial SCF before relaxation')
            path=base/case
            path.mkdir(exist_ok=True)
            for f in [source/'STRU',source/'KPT',source/'run.sh',*source.glob('*.orb'),*source.glob('*.upf')]:
                shutil.copyfile(f,path/f.name)
            params=(source/'INPUT').read_text().replace('calculation scf','calculation relax').replace('out_dos 1','out_dos 0')
            (path/'INPUT').write_text(params+'init_chg file\nread_file_dir '+str((source/'OUT.pbe').resolve())+'/\nforce_thr_ev 0.03\nrelax_nmax 100\nout_stru 1\n')
            job=subprocess.check_output(['sbatch','--parsable','--partition=cpu','--ntasks=1','--cpus-per-task=1','--mem=2G','--time=03:00:00','--job-name=cat-relax-'+case,'--output=slurm-%j.out','run.sh'],cwd=path,text=True)
            ids[case]=job.strip().split(';')[0]
            tmp=receipt.with_suffix('.tmp')
            tmp.write_text(json.dumps(ids))
            tmp.replace(receipt)
        post=submit_spectra(base,ids,relaxed=True)
    return {'starting_jobs':source_ids,'relax_jobs':ids,'spectrum_jobs':post}

def binding_sulfur(model):
    import numpy as np
    hydrogen, = [a for a in model['atoms'] if a['element']=='H']
    candidates=[]
    for i, atom in enumerate(model['atoms'],1):
        if atom['element']=='S':
            frac=np.array(atom['fractional'])-hydrogen['fractional']
            dist=np.linalg.norm((frac-np.round(frac))@model['cell'])
            candidates.append((dist,i))
    return min(candidates)[1]

def relaxed_model(path, model):
    import numpy as np
    lines=[line.split('#')[0].strip() for line in path.read_text().splitlines()]
    rows=iter(line for line in lines[lines.index('ATOMIC_POSITIONS')+1:] if line)
    if next(rows)!='Direct':
        raise ValueError('Expected fractional coordinates in ABACUS geometry')
    atoms=[]
    for element in rows:
        next(rows)
        for _ in range(int(next(rows))):
            position=[float(v) for v in next(rows).split()[:3]]
            atoms.append({'element':element,'fractional':position})
    if [a['element'] for a in atoms]!=[a['element'] for a in model['atoms']]:
        raise ValueError('Relaxation atom order changed.')
    coord=np.array([a['fractional'] for a in atoms])
    cell=np.array(model['cell'])
    def images(i,j):
        v=coord[i]-coord[j]
        return [float(np.linalg.norm((v+[a,b,0])@cell)) for a in (-1,0,1) for b in (-1,0,1)]
    def distance(i,j):
        return min(images(i,j))
    geometry={}
    if atoms[0]['element']=='Mo':
        geometry['initial_trimer_sides_A']=[distance(0,1),distance(0,2),distance(1,2)]
        if atoms[-1]['element']=='H':
            nearest=binding_sulfur({'atoms':atoms,'cell':model['cell']})
            geometry['nearest_S_index']=nearest
            geometry['H_S_distance_A']=distance(-1,nearest-1)
            neighbors=sorted(d for n,atom in enumerate(atoms) if atom['element']=='Mo' for d in images(nearest-1,n))
            geometry['bound_S_nearest_three_Mo_A']=neighbors[:3]
            geometry['bound_S_height_from_Mo_mean_A']=float((coord[nearest-1,2]-np.mean(coord[:4,2]))*cell[2,2])
    else:
        geometry['H_H_distance_A']=distance(0,1)
    return {**model,'atoms':atoms},geometry

def write_poscar(path,model,case):
    elements=[a['element'] for a in model['atoms']]
    species=list(dict.fromkeys(elements))
    rows=['Relaxed '+case,'1.0',*[' '.join(map(str,r)) for r in model['cell']],
          ' '.join(species),' '.join(str(elements.count(e)) for e in species),'Direct',
          *[' '.join(map(str,a['fractional'])) for a in model['atoms']]]
    path.write_text('\n'.join(rows)+'\n')

def read_spectrum(output, fermi, sites):
    import numpy as np
    xml = ET.parse(output/'PDOS').getroot()
    energy = np.fromstring(xml.findtext('energy_values'),sep=' ')
    raw = np.loadtxt(output/'TDOS',ndmin=2)
    if len(energy)<2 or not np.array_equal(energy,raw[:,0]) or not np.all(np.diff(energy)>0):
        raise ValueError('Different native TDOS/PDOS energy grids')
    total = raw[:,1:].sum(axis=1)
    curves = {key: np.zeros_like(total) for key in ['Mo-d','S-p','H-s']}
    site_p = [np.zeros_like(total) for _ in sites]
    orbital_sum = np.zeros_like(total)
    spin = int(xml.findtext('nspin'))
    for node in xml.findall('orbital'):
        values = np.fromstring(node.findtext('data'),sep=' ').reshape((len(energy),spin)).sum(axis=1)
        orbital_sum += values
        key = (node.get('species','').strip(),int(node.get('l')))
        label = {('Mo',2):'Mo-d',('S',1):'S-p',('H',0):'H-s'}.get(key)
        if label:
            curves[label] += values
        if key==('S',1):
            for k,site in enumerate(sites):
                if int(node.get('atom_index'))==site:
                    site_p[k] += values
    if not np.all(np.isfinite(raw)) or not np.allclose(orbital_sum,total,rtol=2e-5,atol=1e-5):
        raise ValueError('Orbital sums disagree with the native total DOS')
    return (energy-fermi,total,*curves.values(),*site_p)

def draw(path, spectra, ids, binding, relaxed):
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib import pyplot as plt
    from matplotlib import font_manager
    import numpy as np
    zh = next((name for name in ('Noto Sans CJK SC','PingFang SC','Arial Unicode MS') if name in font_manager.get_font_names()),'DejaVu Sans')
    with plt.rc_context({'font.family':[zh,'DejaVu Sans'],'axes.unicode_minus':False,'svg.fonttype':'none','font.size':9}):
        fig, axes = plt.subplots(3,1,figsize=(7,7.1),sharex=True,sharey=True)
        fig.subplots_adjust(left=.12,right=.965,top=.82,bottom=.12,hspace=.28)
        fig.text(.065,.966,'基面电子态密度',fontsize=23,weight='bold',color='#173735',va='top')
        stage='弛豫结构' if relaxed else '固定几何'
        fig.text(.067,.9,'1T″-MoS₂   /   '+stage+' · PBE / LCAO   /   9 × 9 × 1 谱线采样',fontsize=10,color='#456360')
        palette = ['#647480','#00796F','#CB7727','#8658A2']
        names = ['总 DOS','Mo d','S p','H s']
        plot_max = max(arr[1][(arr[0]>=-4)&(arr[0]<=2)].max() for arr in spectra.values())
        for ax,(case,arr) in zip(axes,spectra.items()):
            x = arr[0]
            for i,(y,color,label) in enumerate(zip(arr[1:],palette,names)):
                if i==3 and case=='clean':
                    continue
                if i==0:
                    ax.fill_between(x,y,0,color='#CBD3D7',alpha=.42,linewidth=0)
                ax.plot(x,y,color=color,lw=1.1 if i==0 else 1.7,label=label)
            ax.axvline(0,color='#475D5D',lw=.8,ls='--')
            ax.set(xlim=(-4,2),ylim=(-.02*plot_max,1.12*plot_max))
            name = '洁净基面' if case=='clean' else '位点 '+case+' · 吸附 H'
            ax.set_title(name,loc='left',weight='bold',fontsize=11,color='#193A38',pad=3)
            caption = f'作业 {ids[case]}' if case=='clean' else f'ΔE = {binding[case]:+.3f} eV    /    作业 {ids[case]}'
            ax.set_title(caption,loc='right',fontsize=9,color='#526964',pad=3)
            ax.spines[['right','top','left']].set_visible(False)
            ax.spines['bottom'].set_color('#CBD5D2')
            ax.grid(axis='y',color='#E4EAE8',lw=.7)
            ax.tick_params(color='#9BB0A8',labelcolor='#435A56',length=2)
        axes[1].set_ylabel('态密度（states / eV / 晶胞）',fontsize=10)
        axes[-1].set_xlabel('相对各体系费米能级的能量   E − EF  (eV)',fontsize=10)
        handles, labels = axes[-1].get_legend_handles_labels()
        fig.legend(handles,labels,loc='upper left',bbox_to_anchor=(.056,.888),ncol=4,frameon=False,columnspacing=1.8)
        fig.text(.065,.025,'虚线为各体系费米能级。投影按元素与角动量汇总，谱线展宽 0.10 eV。',color='#546964',fontsize=9)
        fig.savefig(path,format='svg',facecolor='white')
        plt.close(fig)

def draw_models(path,models,results):
    import numpy as np
    from matplotlib import pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Circle,Polygon
    font=next((f for f in ('Noto Sans CJK SC','PingFang SC') if f in font_manager.get_font_names()),'DejaVu Sans')
    colors={'Mo':'#456682','S':'#E4AF49','H':'#CF5750'}
    with plt.rc_context({'font.family':[font,'DejaVu Sans'],'svg.fonttype':'none'}):
        fig,axes=plt.subplots(2,2,figsize=(7.7,6.5),gridspec_kw={'height_ratios':[2.1,1]})
        fig.subplots_adjust(left=.04,right=.98,top=.79,bottom=.12,hspace=.02,wspace=.05)
        fig.text(.055,.955,'基面吸氢后的原子结构',fontsize=21,weight='bold',color='#183D39',va='top')
        fig.text(.055,.86,'虚线为晶胞边界。浅色原子为相邻周期像，红圈标出氢原子。',fontsize=10,color='#49635E')
        for col,case in enumerate(('A','B')):
            model=models[case]
            cell=np.array(model['cell'])
            atoms=model['atoms']
            cart=np.array([a['fractional'] for a in atoms])@cell
            for row,ax in enumerate(axes[:,col]):
                tilted=row==1
                def project(r):
                    return np.array([r[0],r[2]-cell[2,2]/2]) if tilted else r[:2]
                visible=[]
                for i in (-1,0,1):
                    for j in (-1,0,1):
                        if tilted and j: continue
                        for n,(atom,center) in enumerate(zip(atoms,cart)):
                            where=center+i*cell[0]+j*cell[1]
                            visible.append((where[1] if tilted else where[2], atom['element'],project(where),not(i or j)))
                if not tilted:
                    border=np.array([cell[0]*0,cell[0],cell[0]+cell[1],cell[1]])[:,:2]
                    ax.add_patch(Polygon(border,closed=True,fill=False,edgecolor='#7F9991',ls='--',lw=.85,zorder=1))
                    ax.set_title('位点 '+case,loc='left',pad=4,color='#21423E',weight='bold',fontsize=13)
                    ax.set(xlim=(-.6,10.4),ylim=(-.65,6.45))
                else:
                    ax.set(xlim=(-.6,10.4),ylim=(-2.15,3.85))
                    ax.text(.02,.95,'侧视',transform=ax.transAxes,va='top',color='#627971',fontsize=8)
                for depth,e,xy,central in sorted(visible,key=lambda v:v[0]):
                    alpha=1.0 if central else .20
                    ax.add_patch(Circle(xy,{'Mo':.38,'S':.285,'H':.17}[e],facecolor=colors[e],edgecolor='white',lw=.5,alpha=alpha,zorder=2))
                h=project(cart[-1])
                ax.add_patch(Circle(h,.38,fill=False,edgecolor='#C24C43',lw=1.4,zorder=4))
                if tilted:
                    ax.annotate('H*',h,h+[.7,.55],color='#A63C37',size=9,arrowprops={'arrowstyle':'-','color':'#AC5650','lw':.7})
                ax.set_aspect('equal');ax.axis('off')
            lo,hi=min(results[case]['initial_trimer_sides_A']),max(results[case]['initial_trimer_sides_A'])
            fig.text(.07+col*.477,.115,f"S–H  {results[case]['H_S_distance_A']:.2f} Å     Mo 三角边  {lo:.2f}–{hi:.2f} Å",fontsize=9,color='#34544F')
            fig.text(.07+col*.477,.079,f"弛豫 {results[case]['ionic_step']} 步    最大力分量 {results[case]['force_max_component_eV_A']:.3f} eV/Å",fontsize=8,color='#59726B')
        for i,(e,color) in enumerate(colors.items()):
            fig.text(.055+i*.135,.039,'●',color=color,fontsize=11)
            fig.text(.08+i*.135,.04,e,fontsize=9,color='#425752')
        fig.savefig(path,format='svg',facecolor='white')
        plt.close(fig)

def collect(root, work, batch, relaxed=False):
    import numpy as np
    if not (work/'jobs.json').exists():
        return {'complete':False, 'state':'NOT_SUBMITTED'}
    log_name='running_relax.log' if relaxed else 'running_scf.log'
    ids = json.loads((work/'jobs.json').read_text())
    results, spectra = {}, {}
    for case in CASES:
        out = work/case/'OUT.pbe'
        log = (out/log_name).read_text(errors='replace') if (out/log_name).exists() else ''
        energy = re.findall(r'!FINAL_ETOT_IS\s+([-+.\dEe]+)\s+eV',log)
        fermi = re.findall(r'EFERMI\s*=\s*([-+.\dEe]+)\s+eV',log)
        complete = bool(energy and fermi and 'charge density convergence is achieved' in log and 'Finish Time' in log)
        iters = re.findall(r'\bELEC=\s*(\d+)',log)
        results[case] = {'job':ids.get(case),'converged':complete,'iterations':int(iters[-1]) if iters else None}
        if relaxed:
            steps=re.findall(r'STEP OF RELAXATION\s*:\s*(\d+)',log)
            gradients=re.findall(r'Largest gradient in force is ([-+.\dEe]+) eV/A',log)
            last_cycle=log.rsplit('STEP OF RELAXATION',1)[-1]
            complete=bool(complete and gradients and float(gradients[-1])<=0.03 and 'charge density convergence is achieved' in last_cycle and 'Relaxation is converged!' in last_cycle)
            results[case].update(converged=complete,ionic_step=int(steps[-1]) if steps else 0,
                force_max_component_eV_A=float(gradients[-1]) if gradients else None)
        if complete:
            results[case].update(total_eV=float(energy[-1]),fermi_eV=float(fermi[-1]))
    if not all(r['converged'] for r in results.values()):
        query = subprocess.run(['squeue','--noheader','--user='+os.environ.get('USER','v100'),'--format=%i %T'],text=True,capture_output=True,check=True)
        queue = dict(line.split() for line in query.stdout.splitlines() if line.strip())
        for r in results.values():
            r['state'] = 'CONVERGED' if r['converged'] else queue.get(r['job'],'ENDED_WITHOUT_CONVERGENCE')
        return {'complete':False,'cases':results}
    models=json.loads((root/('model-'+batch)/'models.json').read_text())['models']
    if relaxed:
        for case in CASES:
            models[case],geometry=relaxed_model(work/case/'OUT.pbe/STRU_ION_D',models[case])
            results[case].update(geometry)
    sites=[binding_sulfur(models[k]) for k in ('A','B')]

    receipts=work/'spectral-jobs.json'
    if not receipts.exists():
        return {'complete':False,'state':'SPECTRA_NOT_SUBMITTED','cases':results}
    post=json.loads(receipts.read_text())
    for case in ('clean','A','B'):
        out=work/(case+'-dos')/'OUT.pbe'
        log=(out/'running_nscf.log').read_text(errors='replace') if (out/'running_nscf.log').exists() else ''
        if 'Finish Time' not in log or not (out/'PDOS').exists():
            queue=subprocess.run(['squeue','--noheader','--format=%i %T'],check=True,capture_output=True,text=True)
            state=dict(row.split() for row in queue.stdout.splitlines() if row.strip()).get(post.get(case),'ENDED_WITHOUT_SPECTRUM')
            return {'complete':False,'case':case,'state':state,'cases':results,'spectrum_jobs':post}
        ef=re.findall(r'EFERMI\s*=\s*([-+.\dEe]+)\s+eV',log)
        ref=float(ef[-1]) if ef else results[case]['fermi_eV']
        results[case].update(spectral_fermi_eV=ref,spectrum_job=post[case])
        spectra[case] = read_spectrum(out,ref,sites)
    binding = {k:results[k]['total_eV']-results['clean']['total_eV']-.5*results['H2']['total_eV'] for k in ('A','B')}
    dest = root/(('relaxed-spectra-' if relaxed else 'spectra-')+batch)
    folder = Path(tempfile.mkdtemp(prefix='.publish-',dir=work))
    files = []
    def record(name):
        if relaxed: name='弛豫-'+name
        files.append(str(dest.name+'/'+name))
        return folder/name
    draw(record('基面电子态密度.svg'),spectra,post,binding,relaxed)
    if relaxed:
        draw_models(record('基面建模.svg'),models,results)
    with record('位点吸附能.csv').open('w') as f:
        w=csv.writer(f)
        w.writerow(['模型','Slurm','电子自洽收敛','总能量_eV','费米能_eV','氢电子吸附能_eV'])
        for case,r in results.items():
            w.writerow([case,r['job'],r['converged'],r['total_eV'],r['fermi_eV'],binding.get(case,'')])
    with record('轨道态密度.csv').open('w') as f:
        w=csv.writer(f)
        w.writerow(['模型','E_minus_Ef_eV','TDOS_states_per_eV','Mo_d_states_per_eV','S_p_states_per_eV','H_s_states_per_eV','site_A_S_p_states_per_eV','site_B_S_p_states_per_eV'])
        for case,arr in spectra.items():
            w.writerows([case,*[format(v,'.8g') for v in row]] for row in zip(*arr))
    for case in CASES:
        if relaxed:
            write_poscar(record(case+'.vasp'),models[case],case)
        else:
            shutil.copyfile(work/case/'POSCAR',record(case+'.vasp'))
        shutil.copyfile(work/case/'OUT.pbe'/log_name,record(case+('-relax.txt' if relaxed else '-SCF.txt')))
        if case in post:
            shutil.copyfile(work/(case+'-dos')/'OUT.pbe/running_nscf.log',record(case+'-DOS.txt'))
    archive=record('原始谱数据.zip')
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=5) as z:
        for case in ('clean','A','B'):
            source=work/(case+'-dos')
            for rel in ['INPUT','KPT','STRU','OUT.pbe/TDOS','OUT.pbe/PDOS','OUT.pbe/running_nscf.log']:
                z.write(source/rel,case+'/'+rel)
        z.writestr('Slurm.json',json.dumps(post,indent=2))
    near = {}
    for case,arr in spectra.items():
        x=arr[0]
        window=np.r_[-.25,x[(x>-.25)&(x<.25)],.25]
        integral=[float(np.sum(np.diff(window)*(line[:-1]+line[1:])*.5)) for y in arr[1:] for line in [np.interp(window,x,y)]]
        near[case]=dict(zip(['total','Mo_d','S_p','H_s','site_A_S_p','site_B_S_p'],integral))
    if dest.is_symlink():
        raise ValueError('Invalid result folder')
    dest.mkdir(mode=0o700,exist_ok=True)
    for artifact in folder.iterdir():
        artifact.replace(dest/artifact.name)
    folder.rmdir()
    return {'complete':True,'method':'ABACUS 3.10.1 PBE/LCAO '+('fixed cell, force relaxed below 0.03 eV/A' if relaxed else 'fixed geometry')+', SCF 5x5x1 (molecule Gamma), NSCF 9x9x1, 60 Ry, Gaussian DOS width 0.10 eV',
            'cases':results,'adsorption_S_atom_numbers':sites,'binding_eV':binding,'near_Ef_integrated_states_minus025_to_plus025_eV':near,'files':files}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['submit','collect','relax','collect_relaxed'])
    p.add_argument('root',type=Path)
    p.add_argument('batch')
    a = p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',a.batch):
        raise ValueError('Invalid batch')
    os.umask(0o077)
    a.root = a.root.resolve(strict=True)
    work = a.root/('.dos-'+a.batch)
    if work.is_symlink() or (a.root/('model-'+a.batch)).is_symlink():
        raise ValueError('Invalid model directory')
    work.mkdir(mode=0o700,exist_ok=True)
    if a.mode=='relax':
        print(json.dumps(submit_relax(work)))
    elif a.mode=='submit':
        models = json.loads((a.root/('model-'+a.batch)/'models.json').read_text())['models']
        print(json.dumps(submit(work,models)))
    else:
        print(json.dumps(collect(a.root,work/'relax' if a.mode=='collect_relaxed' else work,a.batch,relaxed=a.mode=='collect_relaxed'),ensure_ascii=False))
if __name__ == '__main__':
    main()
