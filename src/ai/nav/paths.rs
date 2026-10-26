//! Budgeted path requests: game code (and agents) enqueue, [`process_paths`] answers up to
//! [`crate::ai::AiConfig::path_queries_per_frame`] / `path_budget_ms` per frame.
//!
//! ```ignore
//! let ticket = queue.request(from, to, 0);
//! // later (next frames):
//! if let Some(Ok(path)) = queue.take(ticket) { .. }
//! ```

use std::collections::VecDeque;
use std::time::Instant;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::query::{NavPath, NavQuery, PathError};
use super::sources::NavMeshes;
use crate::ai::agent::{NavAgent, NavAgentState, NavStatus};
use crate::ai::{AiConfig, AiStats};

/// Handle for a queued path request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PathTicket(pub u32);

/// Sent when a ticketed request was answered (take the result with [`NavPathQueue::take`]).
#[derive(Message, Clone, Copy, Debug)]
pub struct PathReady(pub PathTicket);

enum Req {
    Ticket { ticket: PathTicket, from: Vec3, to: Vec3, agent_type: usize },
    Agent(Entity),
}

/// The shared path queue.
#[derive(Resource, Default)]
pub struct NavPathQueue {
    queue: VecDeque<Req>,
    results: HashMap<PathTicket, Result<NavPath, PathError>>,
    next: u32,
}

impl NavPathQueue {
    /// Queues a path from `from` to `to` on agent type `agent_type`'s mesh.
    pub fn request(&mut self, from: Vec3, to: Vec3, agent_type: usize) -> PathTicket {
        self.next = self.next.wrapping_add(1);
        let ticket = PathTicket(self.next);
        self.queue.push_back(Req::Ticket { ticket, from, to, agent_type });
        ticket
    }

    /// The answer, once ready (removes it).
    pub fn take(&mut self, ticket: PathTicket) -> Option<Result<NavPath, PathError>> {
        self.results.remove(&ticket)
    }

    pub fn is_ready(&self, ticket: PathTicket) -> bool {
        self.results.contains_key(&ticket)
    }

    /// Requests waiting.
    pub fn pending(&self) -> usize {
        self.queue.len()
    }

    pub(crate) fn request_agent(&mut self, e: Entity) {
        self.queue.push_back(Req::Agent(e));
    }
}

/// Answers queued requests within the frame budget.
pub(crate) fn process_paths(
    cfg: Res<AiConfig>,
    navs: Res<NavMeshes>,
    mut queue: ResMut<NavPathQueue>,
    mut agents: Query<(Entity, &NavAgent, &mut NavAgentState, &Transform)>,
    mut q: Local<NavQuery>,
    mut stats: ResMut<AiStats>,
    mut ready: MessageWriter<PathReady>,
) {
    // Agents that want a path join the queue once.
    for (e, _, mut st, _) in &mut agents {
        if st.needs_path && !st.queued {
            st.queued = true;
            st.status = NavStatus::Pending;
            queue.request_agent(e);
        }
    }
    let t0 = Instant::now();
    let budget = cfg.path_budget_ms as f64 / 1000.0;
    let mut done = 0u32;
    while done < cfg.path_queries_per_frame && (done == 0 || t0.elapsed().as_secs_f64() < budget) {
        let Some(req) = queue.queue.pop_front() else { break };
        match req {
            Req::Ticket { ticket, from, to, agent_type } => {
                let res = match navs.get(agent_type) {
                    Some(m) => q.find_path(m, from, to, cfg.query_extents, cfg.max_search_nodes),
                    None => Err(PathError::NoStart),
                };
                queue.results.insert(ticket, res);
                ready.write(PathReady(ticket));
            }
            Req::Agent(e) => {
                let Ok((_, agent, mut st, tf)) = agents.get_mut(e) else { continue };
                st.queued = false;
                if !st.needs_path {
                    continue;
                }
                st.needs_path = false;
                let Some(target) = st.target else {
                    st.status = NavStatus::Idle;
                    continue;
                };
                let Some(mesh) = navs.get(agent.agent_type) else { continue };
                let from = tf.translation - Vec3::Y * agent.base_offset;
                let res = q.find_path(mesh, from, target, cfg.query_extents, cfg.max_search_nodes);
                st.set_path(res);
            }
        }
        done += 1;
    }
    stats.path_queries = done;
    stats.path_queue = queue.queue.len() as u32;
    stats.path_us = t0.elapsed().as_micros() as u32;
}
