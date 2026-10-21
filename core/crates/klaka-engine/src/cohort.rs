//! Identitet kohorte iz grafa kroz krugove. Graf (usklađeni glasovi i šabloni) raste iz kruga u
//! krug — kohorta od 16 prefiksa se okuplja za par desetina sekundi — pa prefiksi iste kohorte
//! dobijaju presude u različitim krugovima. Komponenta zato nasleđuje ID kohorte prefiksa koji
//! već ima važeću presudu; kad spoji dve kohorte, važi manji ID, i važeće presude veće prelaze na
//! njega. Uz ID kohorte opis se pravi jednom (`describe.rs`), a recenzent vidi celu kohortu.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use sqlx::PgPool;

use crate::coordinated::Member;

/// Prefiksi po komponenti, iz članova jednog ili više grafova istog kruga: komponente koje
/// dele prefiks (isti prefiks u grafu glasova i grafu šablona) su ista kohorta.
pub fn groups(graphs: &[&[Member]]) -> Vec<(String, BTreeSet<String>)> {
    let mut out: Vec<(String, BTreeSet<String>)> = Vec::new();
    for members in graphs {
        let mut by: BTreeMap<(&str, usize), BTreeSet<String>> = BTreeMap::new();
        for m in *members {
            by.entry((&m.portal, m.component))
                .or_default()
                .insert(m.net.clone());
        }
        for ((portal, _), nets) in by {
            // Spoji sa postojećim grupama istog portala koje dele prefiks.
            let mut merged = nets;
            out.retain(|(p, g)| {
                if p == portal && !g.is_disjoint(&merged) {
                    merged.extend(g.iter().cloned());
                    false
                } else {
                    true
                }
            });
            out.push((portal.to_owned(), merged));
        }
    }
    out
}

/// ID kohorte za svaki prefiks grupa: najmanji ID važećih presuda grupe, ili nov.
pub async fn assign(
    pool: &PgPool,
    groups: &[(String, BTreeSet<String>)],
    now_ms: i64,
) -> Result<HashMap<(String, String), i64>, sqlx::Error> {
    let mut out = HashMap::new();
    for (portal, nets) in groups {
        let keys: Vec<&str> = nets.iter().map(String::as_str).collect();
        let existing: Vec<i64> = sqlx::query_scalar(
            "SELECT DISTINCT cohort FROM verdicts
             WHERE portal = $1 AND key_kind = 'net' AND key = ANY($2) AND action = 'shadow'
               AND until_ms > $3 AND cohort IS NOT NULL
             ORDER BY 1",
        )
        .bind(portal)
        .bind(&keys)
        .bind(now_ms)
        .fetch_all(pool)
        .await?;
        let id = match existing.first() {
            Some(&id) => id,
            None => {
                sqlx::query_scalar("SELECT nextval('verdict_cohort_seq')")
                    .fetch_one(pool)
                    .await?
            }
        };
        if existing.len() > 1 {
            sqlx::query(
                "UPDATE verdicts SET cohort = $1
                 WHERE portal = $2 AND cohort = ANY($3) AND until_ms > $4",
            )
            .bind(id)
            .bind(portal)
            .bind(&existing[1..])
            .bind(now_ms)
            .execute(pool)
            .await?;
        }
        for net in nets {
            out.insert((portal.clone(), net.clone()), id);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(net: &str, component: usize) -> Member {
        Member {
            portal: "demo.local".into(),
            net: net.into(),
            elements: 3,
            partners: 2,
            cohort: 3,
            component,
            posts: 2,
        }
    }

    #[test]
    fn components_sharing_a_prefix_are_one_cohort() {
        // Graf glasova: {a, b} i {c}; graf šablona: {b, d} — b spaja {a, b} i {b, d}.
        let votes = [m("a", 0), m("b", 0), m("c", 1)];
        let templates = [m("b", 0), m("d", 0)];
        let mut got: Vec<Vec<String>> = groups(&[&votes, &templates])
            .into_iter()
            .map(|(_, g)| g.into_iter().collect())
            .collect();
        got.sort();
        assert_eq!(got, [vec!["a", "b", "d"], vec!["c"]]);
    }
}
