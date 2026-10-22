"""Leave-one-out: nearest-example margins and the logistic reading, recall and mistakes on the hard ordinary sentences."""
import json, numpy as np, sys
import os; HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); from data import *
d=json.load(open(os.path.join(HERE, "vecs.json"))); V=np.array(d["vecs"]); T=d["texts"]
n1,n2,n3=len(POS),len(NEG),len(TEST_POS)
P=np.vstack([V[:n1],V[n1+n2:n1+n2+n3]]); N=np.vstack([V[n1:n1+n2],V[n1+n2+n3:]])
PT=POS+TEST_POS; NT=NEG+TEST_NEG
X=np.vstack([P,N]); y=np.r_[np.ones(len(P)),np.zeros(len(N))]; TT=PT+NT
def mk(Pm,Nm,x,k): 
    a=np.sort(Pm@x)[-k:].mean(); b=np.sort(Nm@x)[-k:].mean(); return a-b
for k in [1,2,3]:
  for th in [-0.005,0,0.005,0.01]:
    tp=fp=0; fps=[]; fns=[]
    for i in range(len(y)):
        m=np.ones(len(y),bool); m[i]=False
        Pm=X[m & (y==1)]; Nm=X[m & (y==0)]
        s=mk(Pm,Nm,X[i],k)
        if s>th:
            if y[i]: tp+=1
            else: fp+=1; fps.append(TT[i])
        elif y[i]: fns.append(TT[i])
    print("k",k,"th",th,"recall %d/%d"%(tp,y.sum()),"fp %d/%d"%(fp,(1-y).sum()))
    if k==2 and th==0: print("  FPs:",fps); print("  FNs:",fns)
# standardized logreg LOO
mu=X.mean(0); sd=X.std(0)+1e-6
Z=(X-mu)/sd
def train(Z,y,lam,steps=800,lr=0.1):
    w=np.zeros(Z.shape[1]); b=0.
    for _ in range(steps):
        p=1/(1+np.exp(-(Z@w+b))); w-=lr*(Z.T@(p-y)/len(y)+lam*w); b-=lr*(p-y).mean()
    return w,b
for lam in [0.01,0.1,1.0]:
  res={th:[0,0] for th in [0.3,0.5,0.7]}
  for i in range(len(y)):
    m=np.ones(len(y),bool); m[i]=False
    w,b=train(Z[m],y[m],lam)
    p=1/(1+np.exp(-(Z[i]@w+b)))
    for th in res:
      if p>th: res[th][0 if y[i] else 1]+=1
  print("logreg lam",lam,{th:("rec %d/%d fp %d/%d"%(a,y.sum(),c,(1-y).sum())) for th,(a,c) in res.items()})
