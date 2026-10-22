"""Fits the care layer's linear reading (standardised logistic regression, L2 0.01) on vecs.json; prints its fit; writes weights.json, pasted into app/js/care.js MODEL. Leave-one-out evaluation: loo.py."""
import json, numpy as np, sys
import os; HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); from data import *
d=json.load(open(os.path.join(HERE, "vecs.json"))); V=np.array(d["vecs"])
n1,n2,n3=len(POS),len(NEG),len(TEST_POS)
P=np.vstack([V[:n1],V[n1+n2:n1+n2+n3]]); N=np.vstack([V[n1:n1+n2],V[n1+n2+n3:]])
X=np.vstack([P,N]); y=np.r_[np.ones(len(P)),np.zeros(len(N))]
mu=X.mean(0); sd=X.std(0)+1e-6; Z=(X-mu)/sd
w=np.zeros(384); b=0.
for _ in range(800):
    p=1/(1+np.exp(-(Z@w+b))); w-=0.1*(Z.T@(p-y)/len(y)+0.01*w); b-=0.1*(p-y).mean()
W=w/sd; B=b-(mu*W).sum()
p=1/(1+np.exp(-(X@W+B)))
print("train recall",(p[y==1]>0.5).mean(),"fp",(p[y==0]>0.5).mean(), "fp@0.8",(p[y==0]>0.8).mean(),"rec@0.8",(p[y==1]>0.8).mean())
json.dump({"w":[round(float(x),5) for x in W],"b":round(float(B),5)},open(os.path.join(HERE, "weights.json"), "w"))
