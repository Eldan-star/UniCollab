import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Project, Application, UserRole, Milestone, Message, ApplicationStatus, MilestoneStatus, NotificationType, ProjectStatus, CompensationModel } from '../types.ts';
import { getProjectById, sendMessage, uploadFile, updateApplicationStatus, updateMilestoneStatus } from '../services/apiService.ts';
import { useAuth } from '../hooks/useAuth.ts';
import { useNotifications } from '../hooks/useNotifications.ts';
import Spinner from '../components/ui/Spinner.tsx';
import Button from '../components/ui/Button.tsx';
import ApplicationForm from '../components/applications/ApplicationForm.tsx';
import { Briefcase, CalendarDays, DollarSign, Edit3, Eye, Users, CheckSquare, MessageSquare, Paperclip, Send, UserCheck, UserX, Settings, User } from 'lucide-react';
import MilestoneItem from '../components/projects/MilestoneItem.tsx';
import { supabase } from '../lib/supabaseClient.ts';
import Textarea from '../components/ui/Textarea.tsx';

const ProjectDetailsViewerPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { user } = useAuth();
  const { addNotification } = useNotifications();
  const navigate = useNavigate();
  const location = useLocation();

  const [project, setProject] = useState<Project | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(location.pathname.endsWith('/apply'));
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [chatChannel, setChatChannel] = useState<RealtimeChannel | null>(null);

  const { 
    isOwner, 
    isAcceptedContributor, 
    hasApplied, 
    canApply,
    canChat,
    canManage,
    viewerApplicationStatus
  } = useMemo(() => {
    if (!project || !user) {
      return { isOwner: false, isAcceptedContributor: false, hasApplied: false, canApply: false, canChat: false, canManage: false, viewerApplicationStatus: undefined };
    }
    const owner = user.id === project.posted_by_user_id;
    const acceptedApp = applications.find(app => app.contributor_user_id === user.id && app.status === ApplicationStatus.ACCEPTED);
    const application = applications.find(app => app.contributor_user_id === user.id);
    return {
      isOwner: owner,
      isAcceptedContributor: !!acceptedApp,
      hasApplied: !!application,
      canApply: user.role === UserRole.CONTRIBUTOR && !owner && !application && project.status === ProjectStatus.OPEN,
      canChat: owner || !!acceptedApp,
      canManage: owner,
      viewerApplicationStatus: application?.status
    };
  }, [user, project, applications]);

  const fetchProjectDetails = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: projectError } = await getProjectById(projectId);
      if (projectError) throw projectError;
      if (!data) throw new Error("Project not found");
      setProject(data);
      setApplications(data.applications || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load project details.');
      addNotification(err.message || 'Failed to load project details.', NotificationType.ERROR);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, addNotification]);

  useEffect(() => {
    fetchProjectDetails();
  }, [fetchProjectDetails]);

  useEffect(() => {
    const fetchMessages = async () => {
      if (!canChat || !projectId) return;
      try {
        const { data: msgs, error: msgError } = await supabase.from('messages').select('*, sender_user:users(id,name,profile_photo_url)').eq('project_id', projectId).order('created_at');
        if (msgError) throw msgError;
        setMessages(msgs || []);
      } catch (err: any) {
        console.error("Error fetching messages:", err);
        addNotification('Failed to load chat messages.', NotificationType.WARNING);
      }
    };
    fetchMessages();
  }, [canChat, projectId, addNotification]);

  // --- DEFINITIVE FIX: Stabilized realtime subscription ---
  useEffect(() => {
    if (canChat && projectId && !chatChannel) {
      const newChannel = supabase.channel(`project-chat-${projectId}`);
      newChannel
        .on<Message>(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `project_id=eq.${projectId}` },
          async (payload) => {
            const { data: senderData } = await supabase.from('users').select('id, name, profile_photo_url').eq('id', payload.new.sender_user_id).single();
            const fullMessage = { ...payload.new, sender_user: senderData || undefined };
            setMessages(prev => {
                if (prev.some(m => m.id === fullMessage.id)) return prev;
                return [...prev, fullMessage as Message];
            });
          }
        )
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            console.log(`Subscribed to project chat ${projectId}`);
          } else if (err) {
            console.error(`Error subscribing to chat:`, err);
            addNotification('Realtime chat connection failed.', NotificationType.WARNING, 10000);
          }
        });
      setChatChannel(newChannel);
    }
    return () => {
      if (chatChannel) {
        supabase.removeChannel(chatChannel);
      }
    };
    // CRITICAL FIX: The `chatChannel` state variable is REMOVED from the dependency array to break the infinite loop.
  }, [projectId, canChat, addNotification]);

  const handleSendMessage = async () => {
    if (!projectId || (!newMessage.trim() && !attachment) || !user) return;
    setIsSendingMessage(true);
    try {
      let attachmentUrl: string | undefined;
      if (attachment) {
        const { publicUrl, error: uploadError } = await uploadFile(attachment, 'project-chat-attachments');
        if (uploadError || !publicUrl) throw new Error(uploadError?.message || 'Failed to upload attachment');
        attachmentUrl = publicUrl;
      }
      const { error, data } = await sendMessage(projectId, newMessage.trim(), attachmentUrl);
      if (error) throw error;
      if (data) {
        setMessages(prev => [...prev, data]);
      }
      setNewMessage('');
      setAttachment(null);
    } catch (err: any) {
      addNotification(err.message || 'Failed to send message.', NotificationType.ERROR);
    } finally {
      setIsSendingMessage(false);
    }
  };
  
  const handleApplicationStatusUpdate = async (applicationId: string, newStatus: ApplicationStatus) => {
    if (!isOwner || !project) return;
    try {
      const { error } = await updateApplicationStatus(applicationId, newStatus);
      if (error) throw error;
      addNotification(`Application status updated to ${newStatus}.`, NotificationType.SUCCESS);
      setApplications(prev => prev.map(a => a.id === applicationId ? { ...a, status: newStatus } : a));
      if (newStatus === ApplicationStatus.ACCEPTED) {
        setProject(prev => prev ? { ...prev, status: ProjectStatus.IN_PROGRESS } : null);
      }
    } catch (err: any) {
      addNotification(`Failed to update application: ${err.message}`, NotificationType.ERROR);
    }
  };

  const handleFundMilestone = async (milestone: Milestone) => addNotification(`Initiating funding for milestone: "${milestone.description}" for $${milestone.amount}`, NotificationType.INFO);

  const handleMarkMilestoneComplete = async (milestoneId: string) => {
    if (!isOwner || !projectId) return;
    try {
      const { error, data } = await updateMilestoneStatus(milestoneId, projectId, MilestoneStatus.COMPLETED);
      if (error) throw error;
      addNotification("Milestone marked as complete.", NotificationType.SUCCESS);
      setProject(prev => prev ? { ...prev, milestones: prev.milestones?.map(m => m.id === milestoneId ? (data || { ...m, status: MilestoneStatus.COMPLETED }) : m) } : null);
    } catch (err: any) {
      addNotification(`Failed to update milestone: ${err.message}`, NotificationType.ERROR);
    }
  };

  if (isLoading) return <div className="flex justify-center items-center h-screen"><Spinner size="lg" /></div>;
  if (error) return <div className="text-center text-red-500 p-8">Error: {error}</div>;
  if (!project) return <div className="text-center p-8">Project not found.</div>;

  const displayUserName = project.posted_by_user?.is_anonymous && !isOwner && !isAcceptedContributor ? 'Anonymous Researcher' : project.posted_by_user?.name;
  const displayUserInstitution = project.posted_by_user?.is_anonymous && !isOwner && !isAcceptedContributor ? '' : `(${project.posted_by_user?.institution || 'Unknown'})`;

  return (
    <div className="container mx-auto p-4 md:p-8">
      <div className="bg-white shadow-xl rounded-lg overflow-hidden">
        <div className="p-6 md:p-8 bg-gradient-to-r from-primary to-primary-dark text-white">
          <h1 className="text-3xl md:text-4xl font-bold mb-2">{project.title}</h1>
          <p className="text-sm opacity-90 mb-1">Posted by: {displayUserName} {displayUserInstitution}</p>
          <span className={`px-3 py-1 text-sm font-semibold rounded-full inline-block ${project.status === ProjectStatus.OPEN ? 'bg-green-400 text-green-900' : project.status === ProjectStatus.IN_PROGRESS ? 'bg-yellow-400 text-yellow-900' : project.status === ProjectStatus.COMPLETED ? 'bg-blue-400 text-blue-900' : 'bg-gray-400 text-gray-900'}`}>Status: {project.status.replace(/_/g, ' ')}</span>
        </div>
        <div className="p-6 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div><h2 className="text-xl font-semibold text-gray-700 mb-2 border-b pb-2">Project Description</h2><p className="text-gray-600 whitespace-pre-line">{project.description}</p></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div><h3 className="text-md font-semibold text-gray-700 mb-1">Compensation</h3><p className="text-gray-600 flex items-center">{project.compensation_model === CompensationModel.STIPEND ? <DollarSign size={18} className="mr-2 text-green-600"/> : <Briefcase size={18} className="mr-2 text-gray-500"/>}{project.compensation_model.replace(/_/g, ' ')}{project.compensation_model === CompensationModel.STIPEND && project.stipend_amount && ` ($${project.stipend_amount})`}</p></div>
              <div><h3 className="text-md font-semibold text-gray-700 mb-1">Application Deadline</h3><p className="text-gray-600 flex items-center"><CalendarDays size={18} className="mr-2 text-red-500"/>{project.application_deadline ? new Date(project.application_deadline).toLocaleDateString() : 'Not specified'}</p></div>
            </div>
            {project.required_skills?.length > 0 && <div><h3 className="text-md font-semibold text-gray-700 mb-2">Required Skills</h3><div className="flex flex-wrap gap-2">{project.required_skills.map(skill => <span key={skill} className="bg-primary-light text-primary-dark px-3 py-1 rounded-full text-sm">{skill}</span>)}</div></div>}
            {project.deliverables?.length > 0 && <div><h3 className="text-md font-semibold text-gray-700 mb-2">Deliverables</h3><ul className="list-disc list-inside text-gray-600 space-y-1">{project.deliverables.map((del, i) => <li key={i}>{del}</li>)}</ul></div>}
            {project.confidentiality_agreement_required && <div className="text-sm text-orange-600 bg-orange-100 p-3 rounded-md">Note: A confidentiality agreement will be required for this project.</div>}
            {project.milestones?.length > 0 && <div><h2 className="text-xl font-semibold text-gray-700 mb-3 border-b pb-2">Project Milestones</h2><div className="space-y-3">{project.milestones.map(milestone => <MilestoneItem key={milestone.id} milestone={milestone} isEditable={isOwner} onFund={isOwner ? () => handleFundMilestone(milestone) : undefined} onMarkComplete={isOwner ? () => handleMarkMilestoneComplete(milestone.id) : undefined}/>)}</div></div>}
            {isApplying && canApply && <div className="mt-8"><ApplicationForm project={project} /></div>}
          </div>
          <aside className="lg:col-span-1 space-y-6">
            {canApply && !isApplying && <Button onClick={() => setIsApplying(true)} variant="primary" size="lg" className="w-full" leftIcon={<Edit3 size={18}/>}>Apply to this Project</Button>}
            {hasApplied && !isOwner && <div className="p-4 bg-green-50 border border-green-200 rounded-md text-green-700 text-center">You have applied to this project. Status: <strong>{viewerApplicationStatus}</strong></div>}
            {canManage && project.id && <Link to={`/projects/${project.id}/edit`}><Button variant="outline" size="lg" className="w-full" leftIcon={<Edit3 size={18}/>}>Edit Project Details</Button></Link>}
            <div className="p-4 bg-gray-50 rounded-lg border">
              <h3 className="font-semibold text-gray-700 mb-2">About the Research Lead</h3>
              <div className="flex items-center space-x-3">
                <img src={project.posted_by_user?.profile_photo_url || `https://ui-avatars.com/api/?name=${displayUserName?.replace(' ','+') || 'R L'}&background=0D8ABC&color=fff`} alt={displayUserName || 'Research Lead'} className="w-12 h-12 rounded-full"/>
                <div><p className="font-medium text-primary">{displayUserName}</p><p className="text-sm text-gray-500">{displayUserInstitution}</p></div>
              </div>
            </div>
          </aside>
        </div>
        {canChat && (
          <div className="p-6 md:p-8 border-t">
            <h2 className="text-xl font-semibold text-gray-700 mb-4">Project Chat</h2>
            <div className="h-96 overflow-y-auto border rounded-md p-4 mb-4 bg-gray-50 space-y-3">
              {messages.map(msg => (<div key={msg.id} className={`flex ${msg.sender_user_id === user?.id ? 'justify-end' : 'justify-start'}`}><div className={`max-w-xs lg:max-w-md p-3 rounded-lg shadow ${msg.sender_user_id === user?.id ? 'bg-primary text-white' : 'bg-white text-gray-800 border'}`}><p className="text-xs font-semibold mb-0.5 opacity-80">{msg.sender_user?.name || 'User'} {msg.sender_user_id === user?.id ? '(You)' : ''}</p><p className="text-sm">{msg.message_text}</p>{msg.attachment_url && <a href={msg.attachment_url} target="_blank" rel="noopener noreferrer" className={`mt-1 text-xs flex items-center ${msg.sender_user_id === user?.id ? 'text-blue-200 hover:text-blue-100' : 'text-primary hover:text-primary-dark'}`}><Paperclip size={14} className="mr-1"/> View Attachment</a>}<p className="text-xs opacity-60 mt-1 text-right">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></div></div>))}
              {messages.length === 0 && <p className="text-gray-500 italic text-center py-8">No messages yet.</p>}
            </div>
            <div className="mt-4"><Textarea name="newMessage" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} placeholder="Type your message..." rows={3} containerClassName="mb-2" onKeyDown={(e) => {if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }}}/><div className="flex justify-between items-center"><div className="flex items-center gap-2"><label htmlFor="chat-file-upload" className="cursor-pointer text-gray-500 hover:text-primary"><Paperclip size={22} /></label><input id="chat-file-upload" type="file" className="hidden" onChange={(e) => setAttachment(e.target.files ? e.target.files[0] : null)}/>{attachment && <span className="text-sm text-gray-700">{attachment.name} <button onClick={() => setAttachment(null)} className="text-red-600 hover:text-red-800">×</button></span>}</div><Button onClick={handleSendMessage} disabled={(!newMessage.trim() && !attachment) || isSendingMessage} leftIcon={<Send size={16}/>} isLoading={isSendingMessage}>Send</Button></div></div>
          </div>
        )}
        {isOwner && project.id && (
          <div className="p-6 md:p-8 border-t">
            <h2 className="text-xl font-semibold text-gray-700 mb-4">Applications Received ({applications.length})</h2>
            {applications.length > 0 ? (
              <div className="space-y-4">{applications.map(app => (
                <div key={app.id} className="p-4 border rounded-lg bg-white shadow-sm">
                  <div className="flex justify-between items-start">
                    <div>
                      <Link to={`/profile/${app.contributor_user_id}`} className="hover:underline">
                        <h4 className="font-semibold text-primary">{app.contributor_user?.name || 'Applicant'}</h4>
                      </Link>
                      <p className="text-sm text-gray-500">{app.contributor_user?.email || 'No email'}</p>
                      <p className="text-xs text-gray-400 mt-0.5">Applied: {new Date(app.created_at || Date.now()).toLocaleDateString()}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs font-semibold rounded-full ${app.status === ApplicationStatus.ACCEPTED ? 'bg-green-100 text-green-700' : app.status === ApplicationStatus.SHORTLISTED ? 'bg-yellow-100 text-yellow-700' : app.status === ApplicationStatus.REJECTED ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>{app.status}</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-2 whitespace-pre-line">{app.proposal_text}</p>
                  {(app.cv_url || app.linkedin_url || app.availability || app.proposed_rate) && <div className="mt-2 text-xs space-y-0.5">{app.availability && <p><strong>Availability:</strong> {app.availability}</p>}{app.proposed_rate && <p><strong>Rate:</strong> ${app.proposed_rate}</p>}{app.cv_url && <a href={app.cv_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline block">View CV/Resume</a>}{app.linkedin_url && <a href={app.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline block">LinkedIn Profile</a>}</div>}
                  <div className="mt-3 flex space-x-2 flex-wrap gap-y-2">
                    <Link to={`/profile/${app.contributor_user_id}`}><Button size="sm" variant="outline" leftIcon={<User size={14} />}>View Profile</Button></Link>
                    {(app.status === ApplicationStatus.PENDING || app.status === ApplicationStatus.SHORTLISTED) && (<>
                        <Button size="sm" variant="primary" onClick={() => handleApplicationStatusUpdate(app.id, ApplicationStatus.ACCEPTED)} leftIcon={<UserCheck size={14}/>}>Accept</Button>
                        {app.status === ApplicationStatus.PENDING && <Button size="sm" variant="outline" onClick={() => handleApplicationStatusUpdate(app.id, ApplicationStatus.SHORTLISTED)}>Shortlist</Button>}
                        <Button size="sm" variant="danger" onClick={() => handleApplicationStatusUpdate(app.id, ApplicationStatus.REJECTED)} leftIcon={<UserX size={14}/>}>Reject</Button>
                    </>)}
                  </div>
                </div>
              ))}</div>
            ) : <div className="text-center text-gray-500 italic">No applications received yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectDetailsViewerPage;